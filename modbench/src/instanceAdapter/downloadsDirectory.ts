// Where MO2 keeps this instance's downloads (downloads.md, Which files are rows, story 1):
// `download_directory` resolved as MO2 resolves it, `%BASE_DIR%` included, even outside the
// instance.

import { isAbsolute, join } from 'node:path';
import { readDownloadDirectory } from '../mo2Codecs/modOrganizerIni';
import { defaultDownloadsDir } from './layout';
import { normalizeGamePath, winePrefixDetectorFor, type GameDetectors } from './gameDirectory';
import { errorMessage } from '../ports/errorMessage';

const BASE_DIR_VARIABLE = '%BASE_DIR%';

/** The folder MO2 is actually configured to use, or why Modbench could not tell — never a
 *  guess: a folder Modbench cannot resolve is not the folder MO2 names. */
export type DownloadsDirectoryResolution =
  | { readonly kind: 'resolved'; readonly downloadsDir: string }
  | { readonly kind: 'unresolved'; readonly reason: string };

/** Never rejects: an unresolvable value answers `unresolved` with why, so a configured
 *  `download_directory` can never fail the whole Instance recompute. */
export type DownloadsDirectoryResolver = (instanceRoot: string, iniText: string) => Promise<DownloadsDirectoryResolution>;

/** MO2's `PathSettings::downloads()`: the setting, `%BASE_DIR%` substituted for the instance
 *  root, then joined against it when still relative — real MO2 instead resolves a relative value
 *  against its own process working directory (settings.cpp:1667-1686), undeterminable here. */
export function downloadsDirectoryResolver(detectors?: GameDetectors): DownloadsDirectoryResolver {
  return async (instanceRoot, iniText) => {
    const raw = readDownloadDirectory(iniText);
    if (raw === undefined) return { kind: 'resolved', downloadsDir: defaultDownloadsDir(instanceRoot) };
    const substituted = raw.replaceAll(BASE_DIR_VARIABLE, instanceRoot);
    let normalized: string;
    try {
      normalized = await normalizeGamePath(substituted, process.platform, winePrefixDetectorFor(iniText, detectors));
    } catch (err) {
      return { kind: 'unresolved', reason: `download_directory "${raw}" could not be resolved: ${errorMessage(err)}` };
    }
    const downloadsDir = isAbsolute(normalized) ? normalized : join(instanceRoot, normalized);
    return { kind: 'resolved', downloadsDir };
  };
}

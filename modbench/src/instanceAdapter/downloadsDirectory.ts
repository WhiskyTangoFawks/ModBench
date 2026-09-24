// Where MO2 keeps this instance's downloads (downloads.md, Which files are rows, story 1):
// `download_directory` resolved as MO2 resolves it, `%BASE_DIR%` included, even outside the
// instance.

import { isAbsolute, join } from 'node:path';
import { readDownloadDirectory } from '../mo2Codecs/modOrganizerIni';
import { defaultDownloadsDir } from './layout';
import { normalizeGamePath, winePrefixDetectorFor, type GameDetectors } from './gameDirectory';
import { errorMessage } from '../ports/errorMessage';

const BASE_DIR_VARIABLE = '%BASE_DIR%';

/** Never rejects: an unresolvable value falls back to the default folder, so a configured
 *  `download_directory` can never fail the whole Instance recompute. */
export type DownloadsDirectoryResolver = (instanceRoot: string, iniText: string) => Promise<string>;

/** MO2's `PathSettings::downloads()`: the setting, `%BASE_DIR%` substituted for the instance
 *  root, then joined against it when still relative — real MO2 instead resolves a relative value
 *  against its own process working directory (settings.cpp:1667-1686), undeterminable here. */
export function downloadsDirectoryResolver(
  detectors?: GameDetectors, log: (line: string) => void = () => {},
): DownloadsDirectoryResolver {
  return async (instanceRoot, iniText) => {
    const raw = readDownloadDirectory(iniText);
    if (raw === undefined) return defaultDownloadsDir(instanceRoot);
    const substituted = raw.replaceAll(BASE_DIR_VARIABLE, instanceRoot);
    let normalized: string;
    try {
      normalized = await normalizeGamePath(substituted, process.platform, winePrefixDetectorFor(iniText, detectors));
    } catch (err) {
      // downloads.md names no state for "configured folder unusable" beyond "no downloads yet",
      // which the default folder's own scan reaches naturally.
      log(`[instance] download_directory "${raw}" could not be resolved (${errorMessage(err)}); using the default downloads folder`);
      return defaultDownloadsDir(instanceRoot);
    }
    return isAbsolute(normalized) ? normalized : join(instanceRoot, normalized);
  };
}

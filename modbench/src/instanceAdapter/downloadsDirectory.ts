// Where MO2 keeps this instance's downloads (downloads.md, Which files are rows, story 1):
// `download_directory` resolved as MO2 resolves it, `%BASE_DIR%` included, even outside the
// instance.

import { isAbsolute, join } from 'node:path';
import { readDownloadDirectory } from '../mo2Codecs/modOrganizerIni';
import { defaultDownloadsDir } from './layout';
import { normalizeGamePath, winePrefixDetectorFor, type GameDetectors } from './gameDirectory';

const BASE_DIR_VARIABLE = '%BASE_DIR%';

/** Answers the instance's downloads folder for one generation of ModOrganizer.ini's text — the
 *  Instance's own read, so a resolution can never come from a different generation than the
 *  value it lands in. */
export type DownloadsDirectoryResolver = (instanceRoot: string, iniText: string) => Promise<string>;

/** MO2's `PathSettings::downloads()`: the setting, `%BASE_DIR%` substituted for the instance
 *  root (MO2's own default; a `base_directory` override is unread — Modbench has no UI for one
 *  either), then relative-to-the-instance-root when still relative after that. */
export function downloadsDirectoryResolver(detectors?: GameDetectors): DownloadsDirectoryResolver {
  return async (instanceRoot, iniText) => {
    const raw = readDownloadDirectory(iniText);
    if (raw === undefined) return defaultDownloadsDir(instanceRoot);
    const substituted = raw.replaceAll(BASE_DIR_VARIABLE, instanceRoot);
    const normalized = await normalizeGamePath(substituted, process.platform, winePrefixDetectorFor(iniText, detectors));
    return isAbsolute(normalized) ? normalized : join(instanceRoot, normalized);
  };
}

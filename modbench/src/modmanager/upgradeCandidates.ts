// Pure: which installed mods a download upgrades, and which one its own file id already
// names. Filename is never consulted — meta.ini's mod id and file id are the only identity.

import type { InstanceValue } from './instance';
import type { DownloadRow } from '../mo2Codecs/downloads';
import type { Mod } from './model';

export interface UpgradeCandidate {
  readonly modName: string;
  readonly version?: string;
  /** meta.ini's own `installedFiles` records the download's file id, or failing that the
   *  download named by `installationFile` does — MO2's own two-step provenance. */
  readonly fileIdMatch: boolean;
}

function fileIdMatches(mod: Mod, downloads: readonly DownloadRow[], fileID: string | undefined): boolean {
  if (!fileID) return false;
  if (mod.installedFiles?.some((pair) => pair.fileid === fileID)) return true;
  return mod.archiveFilename !== undefined && downloads.some((d) => d.name === mod.archiveFilename && d.fileID === fileID);
}

/** No candidates — no mod id, or no installed mod sharing it — is the cue to skip the pick.
 *  A file-id match sorts first: the pick's active row. */
export function selectUpgradeCandidates(
  value: Pick<InstanceValue, 'mods' | 'downloads'>,
  download: Pick<DownloadRow, 'modID' | 'fileID'>,
): UpgradeCandidate[] {
  if (!download.modID) return [];
  const candidates = value.mods
    .filter((e): e is Mod => e.kind === 'mod' && e.nexusId === download.modID)
    .map((mod) => ({
      modName: mod.name,
      version: mod.version,
      fileIdMatch: fileIdMatches(mod, value.downloads, download.fileID),
    }));
  const matched = candidates.filter((c) => c.fileIdMatch);
  const unmatched = candidates.filter((c) => !c.fileIdMatch);
  return [...matched, ...unmatched];
}

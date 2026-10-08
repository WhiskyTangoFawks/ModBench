// The installed mods that share a downloaded file's Nexus mod ID, ranked by what the mod manager
// itself recorded. Never a guess from the file's name.

import type { DownloadRow, InstanceValue, Mod } from '../instanceLoader/instance';
import { archiveKey } from '../instanceLoader/downloadRows';
import type { UpgradeCandidate, UpgradeTier } from '../drivingLib/argument';

const isFileIdMatch = (mod: Mod, fileID: string | undefined): boolean =>
  fileID !== undefined && mod.installedFiles?.some((pair) => pair.fileId === fileID) === true;

const isArchiveFilenameMatch = (mod: Mod, downloadName: string): boolean =>
  mod.archiveFilename !== undefined && archiveKey(mod.archiveFilename) === archiveKey(downloadName);

const TIER_RANK: Record<'fileId' | 'archiveFilename' | 'none', number> = { fileId: 0, archiveFilename: 1, none: 2 };

// The pool is the mods sharing the mod id, so no mod id empties it. The tiers rank within the
// pool; a file-id match drops the archive-filename tier for every other mod.
export function upgradeCandidates(
  value: { mods: InstanceValue['mods'] },
  download: Pick<DownloadRow, 'modID' | 'fileID' | 'name'>,
): UpgradeCandidate[] {
  if (!download.modID) return [];
  const pool = value.mods.filter((e): e is Mod => e.kind === 'mod' && e.nexusId === download.modID);
  const hasFileIdMatch = pool.some((mod) => isFileIdMatch(mod, download.fileID));
  const tierOf = (mod: Mod): UpgradeTier | undefined => {
    if (isFileIdMatch(mod, download.fileID)) return 'fileId';
    if (!hasFileIdMatch && isArchiveFilenameMatch(mod, download.name)) return 'archiveFilename';
    return undefined;
  };
  const candidates = pool.map((mod) => ({ modName: mod.name, version: mod.version, tier: tierOf(mod) }));
  return [...candidates].sort((a, b) => TIER_RANK[a.tier ?? 'none'] - TIER_RANK[b.tier ?? 'none']);
}

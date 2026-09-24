// Pure: which installed mods a download upgrades, and which tier of evidence each one carries.
// Two tiers, each a fact MO2 itself recorded — never a guess from the file's name.

import type { DownloadRow, InstanceValue, Mod } from '../instanceLoader/instance';

export type UpgradeTier = 'fileId' | 'installationFile';

// A Windows filename is case-insensitive; this view folds it the same way the status does,
// without reaching past instanceLoader for mo2Codecs's own copy of the same one-liner.
const foldedFilename = (filename: string): string => filename.toLowerCase();

export interface UpgradeCandidate {
  readonly modName: string;
  readonly version?: string;
  /** `fileId` beats `installationFile`; absent, the mod shares only the Nexus mod id. */
  readonly tier?: UpgradeTier;
}

const isFileIdMatch = (mod: Mod, fileID: string | undefined): boolean =>
  fileID !== undefined && mod.installedFiles?.some((pair) => pair.fileid === fileID) === true;

const isInstallationFileMatch = (mod: Mod, downloadName: string): boolean =>
  mod.archiveFilename !== undefined && foldedFilename(mod.archiveFilename) === foldedFilename(downloadName);

const TIER_RANK: Record<'fileId' | 'installationFile' | 'none', number> = { fileId: 0, installationFile: 1, none: 2 };

// No mod id, or no installed mod sharing it, empties the pick. A file-id match sorts first; with
// none, an installation-file match naming this download does; neither still lists, tierless.
export function selectUpgradeCandidates(
  value: { mods: InstanceValue['mods'] },
  download: Pick<DownloadRow, 'modID' | 'fileID' | 'name'>,
): UpgradeCandidate[] {
  if (!download.modID) return [];
  const pool = value.mods.filter((e): e is Mod => e.kind === 'mod' && e.nexusId === download.modID);
  const hasFileIdMatch = pool.some((mod) => isFileIdMatch(mod, download.fileID));
  const tierOf = (mod: Mod): UpgradeTier | undefined => {
    if (isFileIdMatch(mod, download.fileID)) return 'fileId';
    if (!hasFileIdMatch && isInstallationFileMatch(mod, download.name)) return 'installationFile';
    return undefined;
  };
  const candidates = pool.map((mod) => ({ modName: mod.name, version: mod.version, tier: tierOf(mod) }));
  return [...candidates].sort((a, b) => TIER_RANK[a.tier ?? 'none'] - TIER_RANK[b.tier ?? 'none']);
}

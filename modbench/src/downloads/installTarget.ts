// Which install a downloaded file gets: the installed mods that share its Nexus mod ID, ranked by
// what the mod manager itself recorded, shown as one pick. Never a guess from the file's name.

import type * as vscode from 'vscode';
import type { DownloadRow, InstanceValue, Mod } from '../instanceLoader/instance';
import { archiveKey } from '../instanceLoader/downloadRows';
import { defaultModName, type InstallTarget } from '../install/install';
import { pickWithMarked } from '../drivingLib/pickWithMarked';

type UpgradeTier = 'fileId' | 'archiveFilename';

interface UpgradeCandidate {
  readonly modName: string;
  readonly version?: string;
  /** `fileId` beats `archiveFilename`; absent, the mod shares only the Nexus mod id. */
  readonly tier?: UpgradeTier;
}

const isFileIdMatch = (mod: Mod, fileID: string | undefined): boolean =>
  fileID !== undefined && mod.installedFiles?.some((pair) => pair.fileId === fileID) === true;

const isArchiveFilenameMatch = (mod: Mod, downloadName: string): boolean =>
  mod.archiveFilename !== undefined && archiveKey(mod.archiveFilename) === archiveKey(downloadName);

const TIER_RANK: Record<'fileId' | 'archiveFilename' | 'none', number> = { fileId: 0, archiveFilename: 1, none: 2 };

// The pool is the mods sharing the mod id, so no mod id empties it. The tiers rank within the
// pool; a file-id match drops the archive-filename tier for every other mod.
function selectUpgradeCandidates(
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

type InstallChoice =
  | { kind: 'new' }
  | { kind: 'upgrade'; name: string };

interface UpgradePickItem extends vscode.QuickPickItem {
  choice: InstallChoice;
}

const TIER_LABEL: Record<UpgradeTier, string> = {
  fileId: 'File ID match',
  archiveFilename: 'Installed from this file',
};

const NEW_MOD_ITEM: UpgradePickItem = { label: 'Install as a new mod…', choice: { kind: 'new' } };

const upgradePickItems = (candidates: readonly UpgradeCandidate[]): UpgradePickItem[] => [
  ...candidates.map((c): UpgradePickItem => ({
    label: c.version ? `${c.modName} (v${c.version})` : c.modName,
    description: c.tier && TIER_LABEL[c.tier],
    choice: { kind: 'upgrade', name: c.modName },
  })),
  NEW_MOD_ITEM,
];

// The new-mod row is always last, and is the marked one when no candidate carries a tier.
async function pickInstallChoice(name: string, candidates: readonly UpgradeCandidate[]): Promise<InstallChoice | undefined> {
  const items = upgradePickItems(candidates);
  const hasTier = candidates.some((c) => c.tier !== undefined);
  const picked = await pickWithMarked(
    items, hasTier ? items[0] : NEW_MOD_ITEM,
    `"${name}" upgrades an installed mod — choose which one, or install it as a new mod`);
  return picked?.choice;
}

/** `undefined` is Esc, or declining to name a new mod: install nothing. An upgrade arrives
 *  confirmed by the pick, so only a new mod reaches the name prompt. */
export async function chooseInstallTarget(
  value: { mods: InstanceValue['mods'] },
  download: Pick<DownloadRow, 'modID' | 'fileID' | 'name'> & { path: string },
  nameNewMod: (defaultName: string) => Thenable<string | undefined>,
): Promise<InstallTarget | undefined> {
  const candidates = selectUpgradeCandidates(value, download);
  const choice: InstallChoice | undefined =
    candidates.length === 0 ? { kind: 'new' } : await pickInstallChoice(download.name, candidates);
  if (!choice) return undefined;
  if (choice.kind === 'upgrade') return choice;
  const name = await nameNewMod(defaultModName(download.path));
  return name ? { kind: 'new', name } : undefined;
}

// The install target of a downloaded file: the mods Downloads found as its upgrades, shown as one pick.

import type * as vscode from 'vscode';
import { defaultModName, type InstallTarget } from '../install/install';
import { pickWithMarked } from '../drivingLib/pickWithMarked';
import type { DownloadArgument, UpgradeCandidate, UpgradeTier } from '../drivingLib/argument';

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
  { row: download, upgrades: candidates }: DownloadArgument,
  nameNewMod: (defaultName: string) => Thenable<string | undefined>,
): Promise<InstallTarget | undefined> {
  const choice: InstallChoice | undefined =
    candidates.length === 0 ? { kind: 'new' } : await pickInstallChoice(download.name, candidates);
  if (!choice) return undefined;
  if (choice.kind === 'upgrade') return choice;
  const name = await nameNewMod(defaultModName(download.path));
  return name ? { kind: 'new', name } : undefined;
}

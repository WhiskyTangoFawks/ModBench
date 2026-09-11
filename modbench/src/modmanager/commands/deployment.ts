// Deploy and purge as gesture commands (ADR-0015 invariant 2): applied-or-refusal, never a throw.
// Winners come from the Instance, not a fresh walk, so deploy can't disagree with the trees.

import { deploy, isDeployed, purge, type LoadOrderDeployment } from '../deployer';
import { pluginsFile } from '../mo2/layout';
import type { Reporter } from '../../reporter';
import type { FileWinners } from '../fileConflictIndex';
import type { GameDirectory } from '../gameDirectory';
import { createWriteQueue } from './writeQueue';

/** `wrote` is false when a precondition aborted the run, or when purge found nothing deployed —
 *  in both cases Data/ and the manifest are exactly as they were. */
export type DeploymentCommandResult =
  | { applied: true; wrote: boolean }
  | { applied: false; refusal: string };

const NO_GAME_DIRECTORY =
  'No game directory found. Set modbench.mods.gameDirectory to your Stock Game Folder or Steam install.';

const DEPLOY_DECLINED = 'Deploy declined — Modbench was not confirmed as the deployer; nothing was written.';

/** The `vscode.window.showWarningMessage` slice the confirm below needs, injected so it is
 *  testable without a VS Code host — `eslFlagRemovalPrompt.ts`'s idiom. */
export type ShowFirstDeployPrompt = (
  message: string, options: { modal: true }, ...buttons: string[]
) => Thenable<string | undefined> | Promise<string | undefined>;

export const DEPLOY_CONFIRM_BUTTON = 'Deploy';

// Keyed on the manifest's absence, so a directory that already has one never asks again.
async function confirmFirstDeploy(showWarning: ShowFirstDeployPrompt): Promise<boolean> {
  const choice = await showWarning(
    'Modbench has never deployed into this game directory. Deploying now hardlinks your enabled ' +
      'mods into Data/ and makes Modbench the deployer — if MO2 or another tool also deploys here, ' +
      'the two will conflict. Continue?',
    { modal: true },
    DEPLOY_CONFIRM_BUTTON,
  );
  return choice === DEPLOY_CONFIRM_BUTTON;
}

// Deploy and purge share one queue per instance root: both read-modify-write the same manifest,
// and an overlapping pair would snapshot Data/ as vanilla while it still holds live links.
const withDeploymentLock = createWriteQueue();

const refuse = (err: unknown): DeploymentCommandResult => ({
  applied: false,
  refusal: err instanceof Error ? err.message : String(err),
});

/** `files` and `profile` are the Instance's own `files`/`activeProfile` fields, never a fresh
 *  walk. `loadOrderTarget` is where the game reads plugins.txt; undefined leaves the load order
 *  undeployed, which is the state on a machine whose paths never resolved. */
export function deployMods(
  instanceRoot: string,
  profile: string,
  files: FileWinners,
  gameDirectory: GameDirectory | undefined,
  loadOrderTarget: string | undefined,
  reporter: Reporter,
  showWarning: ShowFirstDeployPrompt,
): Promise<DeploymentCommandResult> {
  return withDeploymentLock(instanceRoot, async (): Promise<DeploymentCommandResult> => {
    if (!gameDirectory) return { applied: false, refusal: NO_GAME_DIRECTORY };
    if (!(await isDeployed(instanceRoot)) && !(await confirmFirstDeploy(showWarning))) {
      return { applied: false, refusal: DEPLOY_DECLINED };
    }
    try {
      const loadOrder: LoadOrderDeployment[] = loadOrderTarget
        ? [{ source: pluginsFile(instanceRoot, profile), target: loadOrderTarget }]
        : [];
      return { applied: true, wrote: await deploy(instanceRoot, gameDirectory, { files }, reporter, { loadOrder }) };
    } catch (err) {
      return refuse(err);
    }
  });
}

export function purgeMods(
  instanceRoot: string,
  gameDirectory: GameDirectory | undefined,
  reporter: Reporter,
): Promise<DeploymentCommandResult> {
  return withDeploymentLock(instanceRoot, async (): Promise<DeploymentCommandResult> => {
    if (!gameDirectory) return { applied: false, refusal: NO_GAME_DIRECTORY };
    try {
      return { applied: true, wrote: await purge(instanceRoot, gameDirectory, reporter) };
    } catch (err) {
      return refuse(err);
    }
  });
}

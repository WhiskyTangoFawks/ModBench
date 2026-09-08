// Deploy and purge as gesture commands (ADR-0047 point 6). Each walks disk for what it needs
// and returns applied or a refusal; the deploy manifest's own watcher is how the result comes
// back to the trees.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deploy, purge, type LoadOrderDeployment, type Reporter } from '../deployer';
import { buildFileConflictIndex } from '../fileConflictIndex';
import type { GameDirectory } from '../gameDirectory';
import { parseModlist } from '../mo2/modlistText';

/** `wrote` is false when a precondition aborted the run, or when purge found nothing deployed —
 *  in both cases Data/ and the manifest are exactly as they were. */
export type DeploymentCommandResult =
  | { applied: true; wrote: boolean }
  | { applied: false; refusal: string };

const NO_GAME_DIRECTORY =
  'No game directory found. Set modbench.mods.gameDirectory to your Stock Game Folder or Steam install.';

// Deploy and purge share one queue per instance root: both read-modify-write the same manifest,
// and an overlapping pair would snapshot Data/ as vanilla while it still holds live links.
const deploymentQueues = new Map<string, Promise<unknown>>();

function withDeploymentLock<T>(instanceRoot: string, task: () => Promise<T>): Promise<T> {
  const prior = deploymentQueues.get(instanceRoot) ?? Promise.resolve();
  const next = prior.then(task, task);
  deploymentQueues.set(instanceRoot, next.catch(() => undefined));
  return next;
}

const refuse = (err: unknown): DeploymentCommandResult => ({
  applied: false,
  refusal: err instanceof Error ? err.message : String(err),
});

/** `loadOrderTarget` is where the game reads plugins.txt; undefined leaves the load order
 *  undeployed, which is the state on a machine whose paths never resolved. */
export function deployMods(
  instanceRoot: string,
  profile: string,
  gameDirectory: GameDirectory | undefined,
  loadOrderTarget: string | undefined,
  reporter: Reporter,
  log: (msg: string) => void,
): Promise<DeploymentCommandResult> {
  return withDeploymentLock(instanceRoot, async (): Promise<DeploymentCommandResult> => {
    if (!gameDirectory) return { applied: false, refusal: NO_GAME_DIRECTORY };
    try {
      const profileDir = join(instanceRoot, 'profiles', profile);
      const entries = parseModlist(await readFile(join(profileDir, 'modlist.txt'), 'utf8'));
      const index = await buildFileConflictIndex(entries, instanceRoot, log);
      const loadOrder: LoadOrderDeployment[] = loadOrderTarget
        ? [{ source: join(profileDir, 'plugins.txt'), target: loadOrderTarget }]
        : [];
      return { applied: true, wrote: await deploy(instanceRoot, gameDirectory, index, reporter, { loadOrder }) };
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

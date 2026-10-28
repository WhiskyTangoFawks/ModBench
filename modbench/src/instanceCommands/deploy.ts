import { join } from 'node:path';
import type { InstanceAdapter } from '../instanceAdapter/instanceAdapter';
import { isWithin } from '../instanceAdapter/gameFolder/pathWithin';
import { overwritePathOf, type Deployed, type Deployment, type FileTheGameGets, type PluginOrder } from '../deployment/deployment';
import { gameReleaseForGame } from '../tables/gamePaths';
import { refuse } from '../coreLib/refuse';
import type { CommandResult } from '../coreLib/commandResult';

export interface DeploymentFolderSetting {
  readonly id: string;
  /** What VS Code holds of the setting. */
  inspect(): { workspaceValue?: string; globalValue?: string } | undefined;
}

/** The instance's deployment folder: the workspace's value alone, as a user-level value is every instance's. */
export const deploymentFolderOf = (setting: Pick<DeploymentFolderSetting, 'inspect'>): string | undefined =>
  setting.inspect()?.workspaceValue || undefined;

/** What the instance holds of the load order: the files the game gets, and the plugin rows, each with its plugins.txt line. */
export interface LoadOrderToDeploy {
  readonly files: Iterable<FileTheGameGets>;
  readonly plugins: readonly { readonly name: string; readonly line: number | null; readonly enabled: boolean }[];
  readonly gameName: string;
}

// An overridden plugin shares the line of the one that wins, so one entry stands for each line.
function pluginOrderOf({ plugins, gameName }: LoadOrderToDeploy): PluginOrder {
  const byLine = new Map<number, { name: string; enabled: boolean }>();
  for (const { name, line, enabled } of plugins) if (line !== null && !byLine.has(line)) byLine.set(line, { name, enabled });
  return { release: gameReleaseForGame(gameName), entries: [...byLine].sort(([a], [b]) => a - b).map(([, entry]) => entry) };
}

type Adapter = Pick<InstanceAdapter, 'moveIntoOverwrite' | 'gameFolder'>;

/** `canMoveToOverwrite` is false when the deployment folder overlaps the game folder, whose files are not Overwrite's. */
export type DeployResult = CommandResult<Deployed & { canMoveToOverwrite: boolean }>;

async function overlapsGameFolder(adapter: Pick<InstanceAdapter, 'gameFolder'>, folder: string): Promise<string | undefined> {
  const game = await adapter.gameFolder();
  return game.kind === 'found' && (await isWithin(folder, game.root) || await isWithin(game.root, folder)) ? game.root : undefined;
}

async function deploy(
  { deployment, adapter }: { deployment: Deployment; adapter: Pick<InstanceAdapter, 'gameFolder'> },
  setting: DeploymentFolderSetting, load: LoadOrderToDeploy | undefined,
): Promise<DeployResult> {
  const folder = deploymentFolderOf(setting);
  if (folder === undefined) return { applied: false, refusal: `No deployment folder: set ${setting.id}.` };
  if (load === undefined) return { applied: false, refusal: 'The instance has not been read.' };
  try {
    const deployed = await deployment.deploy(folder, load.files, pluginOrderOf(load));
    return { applied: true, ...deployed, canMoveToOverwrite: deployed.unmanaged.length > 0 && await overlapsGameFolder(adapter, folder) === undefined };
  } catch (err) {
    return refuse(err);
  }
}

/** `left` names each file no mod file can land at the path of, which stays in the deployment folder. */
export type MoveToOverwriteResult = CommandResult<{ wrote: boolean; left: readonly string[] }>;

async function moveToOverwrite(
  { adapter, deployment }: { adapter: Adapter; deployment: Deployment }, setting: DeploymentFolderSetting, named: readonly string[] | undefined,
): Promise<MoveToOverwriteResult> {
  const folder = deploymentFolderOf(setting);
  if (folder === undefined) return { applied: false, refusal: `No deployment folder: set ${setting.id}.` };
  try {
    const game = await overlapsGameFolder(adapter, folder);
    if (game !== undefined) {
      return { applied: false, refusal: `The deployment folder ${folder} is, holds or sits inside the game folder ${game}: moving the game's own files out of it would break the game.` };
    }
    const paths = named ?? await deployment.unmanaged(folder);
    const moves = paths.flatMap((path) => {
      const relativePath = overwritePathOf(path);
      return relativePath === undefined ? [] : [{ from: join(folder, path), relativePath }];
    });
    const refusal = await adapter.moveIntoOverwrite(moves);
    if (refusal !== undefined) return { applied: false, refusal };
    return { applied: true, wrote: moves.length > 0, left: paths.filter((path) => overwritePathOf(path) === undefined) };
  } catch (err) {
    return refuse(err);
  }
}

/** The deployment's commands, bound to its deployment, its folder's setting and the instance's Overwrite. `load` is the load
 *  order to deploy, undefined while the instance has not been read. */
export function deployCommands(
  { deployment, deploymentFolder, adapter }: { deployment: Deployment; deploymentFolder: DeploymentFolderSetting; adapter: Adapter },
) {
  return {
    deploy: (load: LoadOrderToDeploy | undefined) => deploy({ deployment, adapter }, deploymentFolder, load),
    moveToOverwrite: (paths?: readonly string[]) => moveToOverwrite({ adapter, deployment }, deploymentFolder, paths),
  };
}

export type DeployCommands = ReturnType<typeof deployCommands>;

import { join } from 'node:path';
import type { InstanceAdapter } from '../instanceAdapter/instanceAdapter';
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

export type DeployResult = CommandResult<Deployed>;

async function deploy(
  deployment: Deployment, setting: DeploymentFolderSetting, load: LoadOrderToDeploy | undefined,
): Promise<DeployResult> {
  const folder = deploymentFolderOf(setting);
  if (folder === undefined) return { applied: false, refusal: `No deployment folder: set ${setting.id}.` };
  if (load === undefined) return { applied: false, refusal: 'The instance has not been read.' };
  try {
    return { applied: true, ...(await deployment.deploy(folder, load.files, pluginOrderOf(load))) };
  } catch (err) {
    return refuse(err);
  }
}

/** `left` names each file no mod file can land at the path of, which stays in the deployment folder. */
export type MoveToOverwriteResult = CommandResult<{ wrote: boolean; left: readonly string[] }>;

// A file moves to Overwrite at the path the next deploy links it back from.
async function moveToOverwrite(
  adapter: Pick<InstanceAdapter, 'moveIntoOverwrite'>, setting: DeploymentFolderSetting, paths: readonly string[],
): Promise<MoveToOverwriteResult> {
  const folder = deploymentFolderOf(setting);
  if (folder === undefined) return { applied: false, refusal: `No deployment folder: set ${setting.id}.` };
  const moves = paths.flatMap((path) => {
    const relativePath = overwritePathOf(path);
    return relativePath === undefined ? [] : [{ from: join(folder, path), relativePath }];
  });
  try {
    await adapter.moveIntoOverwrite(moves);
    return { applied: true, wrote: moves.length > 0, left: paths.filter((path) => overwritePathOf(path) === undefined) };
  } catch (err) {
    return refuse(err);
  }
}

/** The deployment's commands, bound to its deployment, its folder's setting and the instance's Overwrite. `load` is the load
 *  order to deploy, undefined while the instance has not been read. */
export function deployCommands(
  { deployment, deploymentFolder, adapter }: { deployment: Deployment; deploymentFolder: DeploymentFolderSetting; adapter: Pick<InstanceAdapter, 'moveIntoOverwrite'> },
) {
  return {
    deploy: (load: LoadOrderToDeploy | undefined) => deploy(deployment, deploymentFolder, load),
    moveToOverwrite: (paths: readonly string[]) => moveToOverwrite(adapter, deploymentFolder, paths),
  };
}

export type DeployCommands = ReturnType<typeof deployCommands>;

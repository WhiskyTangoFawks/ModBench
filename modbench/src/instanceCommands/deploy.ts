// Deploy (deployment-hardlink.md): the one command that hands the instance value on, to Deployment as
// the load order to deploy (target-architecture.md).

import type { Deployed, Deployment, FileTheGameGets } from '../deployment/deployment';
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

export type DeployResult = CommandResult<Deployed>;

async function deploy(
  deployment: Deployment, setting: DeploymentFolderSetting, files: Iterable<FileTheGameGets> | undefined,
): Promise<DeployResult> {
  const folder = deploymentFolderOf(setting);
  if (folder === undefined) return { applied: false, refusal: `No deployment folder: set ${setting.id}.` };
  if (files === undefined) return { applied: false, refusal: 'The instance has not been read.' };
  try {
    return { applied: true, ...(await deployment.deploy(folder, files)) };
  } catch (err) {
    return refuse(err);
  }
}

/** The deployment's commands, bound to its deployment and its folder's setting. `files` is the load
 *  order to deploy, undefined while the instance has not been read. */
export function deployCommands({ deployment, deploymentFolder }: { deployment: Deployment; deploymentFolder: DeploymentFolderSetting }) {
  return {
    deploy: (files: Iterable<FileTheGameGets> | undefined) => deploy(deployment, deploymentFolder, files),
  };
}

export type DeployCommands = ReturnType<typeof deployCommands>;

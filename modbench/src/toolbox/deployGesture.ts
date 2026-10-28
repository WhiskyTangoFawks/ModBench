import * as vscode from 'vscode';
import type { Instance } from '../instanceLoader/instance';
import type { DeployCommands, DeployResult } from '../instanceCommands/deploy';
import { AgentCall } from '../drivingLib/agentGesture';
import { runWritingGesture } from '../drivingLib/writingGesture';
import type { Reporter } from '../ports/reporter';
import { deployFailures, deployWarnings, unmanagedWarning } from './deployProblems';
import { registerDeployTask } from './deployTask';
import { TOOLBOX_VIEW } from './toolboxCommands';

interface DeployGestureDeps {
  commands: Pick<DeployCommands, 'deploy' | 'purge' | 'moveToOverwrite'>;
  instance: Pick<Instance, 'landed' | 'sequence' | 'refresh'>;
  reporter: Reporter;
}

const MOVE_TO_OVERWRITE = 'modbench.instance.moveToOverwrite';

// deployment-hardlink.md, Deploy, story 7: deploy asks nothing.
export function registerDeployCommands({ commands, instance, reporter }: DeployGestureDeps): vscode.Disposable[] {
  const deploy = async (reportsItself: boolean): Promise<DeployResult> => {
    const { files, plugins, gameName } = await instance.landed();
    const result = await commands.deploy(instance.sequence === 0 ? undefined : { files, plugins, gameName });
    if (reportsItself) return result;
    if (!result.applied) {
      reporter.report('error', 'Could not deploy.', result.refusal);
      return result;
    }
    const unmanaged = unmanagedWarning(result);
    if (unmanaged !== undefined) {
      reporter.shownOnSurface('warning', unmanaged.message, unmanaged.detail);
      reporter.report('warning', `The deployment folder holds ${result.unmanaged.length} files deploy does not manage, each named in the Output.`, undefined,
        result.canMoveToOverwrite ? { title: 'Move to Overwrite', run: () => void vscode.commands.executeCommand(MOVE_TO_OVERWRITE, result.unmanaged) } : undefined);
    }
    for (const { message, detail } of [...deployFailures(result), ...deployWarnings(result)]) reporter.report('warning', message, detail);
    return result;
  };
  // deployment-hardlink.md, Purge, story 2: purge asks nothing.
  const purge = async (): Promise<void> => {
    const result = await commands.purge();
    if (!result.applied) {
      reporter.report('error', 'Could not purge.', result.refusal);
      return;
    }
    if (result.unmanaged.length > 0) {
      reporter.shownOnSurface('warning', 'The deployment folder holds files purge did not remove:', result.unmanaged.join(', '));
      reporter.report('warning', `The deployment folder holds ${result.unmanaged.length} files purge did not remove, each named in the Output.`);
    }
    if (result.leftRenamed.length > 0) {
      reporter.report('warning', 'Purge left each plugins.txt deploy renamed, which is yours to put back:', result.leftRenamed.join(', '));
    }
    if (result.unfinished.length > 0) {
      reporter.report('warning', 'Purge landed, and could not finish:', result.unfinished.join(', '));
    }
  };
  // The game folder can be the deployment folder (deployment-hardlink.md, story 4), and the instance value reads its Data folder.
  return [
    registerDeployTask(reporter),
    vscode.commands.registerCommand('modbench.instance.deploy', (called?: unknown) => runWritingGesture(TOOLBOX_VIEW, instance, () => deploy(called instanceof AgentCall))),
    vscode.commands.registerCommand('modbench.instance.purge', () => runWritingGesture(TOOLBOX_VIEW, instance, purge)),
    registerMoveToOverwriteCommand({ commands, instance, reporter }),
  ];
}

// deployment-hardlink.md, Files deploy does not manage, story 4: the notification of deploy names the files.
function registerMoveToOverwriteCommand({ commands, instance, reporter }: DeployGestureDeps): vscode.Disposable {
  const move = async (paths: unknown): Promise<void> => {
    const named = Array.isArray(paths) && paths.every((path) => typeof path === 'string') ? paths : undefined;
    const result = await commands.moveToOverwrite(named);
    if (!result.applied) {
      reporter.report('error', 'Could not move to Overwrite.', result.refusal);
    } else if (result.left.length > 0) {
      reporter.report('warning', 'Left in the deployment folder, because no mod file lands at their path:', result.left.join(', '));
    }
  };
  return vscode.commands.registerCommand(MOVE_TO_OVERWRITE, (paths: unknown) => runWritingGesture(TOOLBOX_VIEW, instance, () => move(paths)));
}

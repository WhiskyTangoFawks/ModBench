import * as vscode from 'vscode';
import type { Instance } from '../instanceLoader/instance';
import type { DeployCommands, DeployResult } from '../instanceCommands/deploy';
import { AgentCall } from '../drivingLib/agentGesture';
import { runWritingGesture } from '../drivingLib/writingGesture';
import type { Reporter } from '../ports/reporter';
import { deployFailures, deployWarnings } from './deployProblems';
import { MOVE_TO_OVERWRITE, publishUnmanagedProblems } from './unmanagedProblems';
import { registerDeployTask } from './deployTask';
import { TOOLBOX_VIEW } from './toolboxCommands';

interface DeployGestureDeps {
  commands: Pick<DeployCommands, 'deploy' | 'purge' | 'moveToOverwrite' | 'unmanaged'>;
  instance: Pick<Instance, 'landed' | 'sequence' | 'refresh'>;
  reporter: Reporter;
}

export function registerDeployCommands({ commands, instance, reporter }: DeployGestureDeps): vscode.Disposable[] {
  const problems = vscode.languages.createDiagnosticCollection('modbench-deployment-unmanaged');
  let leftOut: readonly { path: string; winner: string }[] = [];
  // The folder is read again after each gesture that changes it, and a file the user changes by hand is read at the next of them.
  const publishProblems = async (): Promise<void> => {
    const held = await commands.unmanaged();
    if (held.applied) publishUnmanagedProblems(problems, held.unmanaged, leftOut);
    else problems.clear();
  };
  const deploy = async (reportsItself: boolean): Promise<DeployResult> => {
    const { files, plugins, gameName } = await instance.landed();
    const result = await commands.deploy(instance.sequence === 0 ? undefined : { files, plugins, gameName });
    if (result.applied) leftOut = result.leftOut;
    await publishProblems();
    if (reportsItself) return result;
    if (!result.applied) {
      reporter.report('error', 'Could not deploy.', result.refusal);
      return result;
    }
    for (const { message, detail } of [...deployFailures(result), ...deployWarnings(result)]) reporter.report('warning', message, detail);
    return result;
  };
  const purge = async (): Promise<void> => {
    const result = await commands.purge();
    await publishProblems();
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
  // The game folder can be the deployment folder (deployment-hardlink.md, The deployment folder, story 4), and
  // the instance value reads its Data folder.
  return [
    registerDeployTask(reporter),
    vscode.commands.registerCommand('modbench.instance.deploy', (called?: unknown) => runWritingGesture(TOOLBOX_VIEW, instance, () => deploy(called instanceof AgentCall))),
    vscode.commands.registerCommand('modbench.instance.purge', () => runWritingGesture(TOOLBOX_VIEW, instance, purge)),
    registerMoveToOverwriteCommand({ commands, instance, reporter }, publishProblems),
    problems,
  ];
}

// deployment-hardlink.md, Files deploy does not manage, story 4: the link on each problem fires it with that file.
function registerMoveToOverwriteCommand({ commands, instance, reporter }: DeployGestureDeps, publishProblems: () => Promise<void>): vscode.Disposable {
  const move = async (paths: unknown): Promise<void> => {
    const named = Array.isArray(paths) && paths.every((path) => typeof path === 'string') ? paths : undefined;
    const result = await commands.moveToOverwrite(named);
    await publishProblems();
    if (!result.applied) {
      reporter.report('error', 'Could not move to Overwrite.', result.refusal);
    } else if (result.left.length > 0) {
      reporter.report('warning', 'Left in the deployment folder, because no mod file lands at their path:', result.left.join(', '));
    }
  };
  return vscode.commands.registerCommand(MOVE_TO_OVERWRITE, (paths: unknown) => runWritingGesture(TOOLBOX_VIEW, instance, () => move(paths)));
}

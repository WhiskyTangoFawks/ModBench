import * as vscode from 'vscode';
import type { Instance } from '../instanceLoader/instance';
import type { DeployCommands, DeployResult } from '../instanceCommands/deploy';
import { AgentCall } from '../drivingLib/agentGesture';
import { runWritingGesture } from '../drivingLib/writingGesture';
import type { Reporter } from '../ports/reporter';
import { deployFailures, deployWarnings } from './deployProblems';
import { coalesced } from '../ports/coalesced';
import { MOVE_TO_OVERWRITE, unmanagedProblems } from './unmanagedProblems';
import { registerDeployTask } from './deployTask';
import { TOOLBOX_VIEW } from './toolboxCommands';

interface DeployGestureDeps {
  commands: Pick<DeployCommands, 'deploy' | 'purge' | 'moveToOverwrite' | 'unmanaged'>;
  instance: Pick<Instance, 'landed' | 'sequence' | 'refresh'>;
  reporter: Reporter;
}

export function registerDeployCommands({ commands, instance, reporter }: DeployGestureDeps): vscode.Disposable[] {
  const collection = vscode.languages.createDiagnosticCollection('modbench-deployment-unmanaged');
  const problems = unmanagedProblems(collection);
  let leftOut: readonly { path: string; winner: string }[] = [];
  let watched: { folder: string; watcher: vscode.FileSystemWatcher } | undefined;
  // A change in the folder only triggers the read; the disk answers (ADR-0003).
  const reread = coalesced(() => { void publishProblems(); });
  const watch = (folder: string | undefined): void => {
    if (watched?.folder === folder) return;
    watched?.watcher.dispose();
    watched = undefined;
    if (folder === undefined) return;
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(folder), '**/*'));
    watcher.onDidCreate(reread);
    watcher.onDidChange(reread);
    watcher.onDidDelete(reread);
    watched = { folder, watcher };
  };
  const publishProblems = async (): Promise<void> => {
    const held = await commands.unmanaged();
    watch(held.applied ? held.folder : undefined);
    if (held.applied) problems.publish(held.unmanaged, leftOut);
    else collection.clear();
  };
  const deploy = async (reportsItself: boolean): Promise<DeployResult> => {
    const { files, plugins, gameName } = await instance.landed();
    const result = await commands.deploy(instance.sequence === 0 ? undefined : { files, plugins, gameName });
    leftOut = result.applied ? result.leftOut : [];
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
    leftOut = [];
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
    collection,
    { dispose: () => { watched?.watcher.dispose(); } },
    vscode.languages.registerCodeActionsProvider({ scheme: 'file' }, problems.quickFixes, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
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

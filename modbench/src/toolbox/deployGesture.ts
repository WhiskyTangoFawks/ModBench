import * as vscode from 'vscode';
import type { Instance } from '../instanceLoader/instance';
import type { DeployCommands } from '../instanceCommands/deploy';
import { runWritingGesture } from '../drivingLib/writingGesture';
import type { Reporter } from '../ports/reporter';
import { TOOLBOX_VIEW } from './toolboxCommands';

interface DeployGestureDeps {
  commands: Pick<DeployCommands, 'deploy' | 'moveToOverwrite'>;
  instance: Pick<Instance, 'landed' | 'sequence' | 'refresh'>;
  reporter: Reporter;
}

const MOVE_TO_OVERWRITE = 'modbench.instance.moveToOverwrite';

// deployment-hardlink.md, Deploy, story 7: deploy asks nothing.
export function registerDeployCommands({ commands, instance, reporter }: DeployGestureDeps): vscode.Disposable[] {
  const deploy = async (): Promise<void> => {
    const { files, plugins, gameName } = await instance.landed();
    const result = await commands.deploy(instance.sequence === 0 ? undefined : { files, plugins, gameName });
    if (!result.applied) {
      reporter.report('error', 'Could not deploy.', result.refusal);
      return;
    }
    if (result.leftOut.length > 0) {
      reporter.report('warning', 'Deploy left out each file whose path holds a file it did not write:',
        result.leftOut.map(({ path, winner }) => `${winner} at ${path}`).join(', '));
    }
    if (result.unmanaged.length > 0) {
      const { unmanaged } = result;
      reporter.shownOnSurface('warning', 'The deployment folder holds files deploy does not manage:', unmanaged.join(', '));
      reporter.report('warning', `The deployment folder holds ${unmanaged.length} files deploy does not manage, each named in the Output.`, undefined,
        result.canMoveToOverwrite ? { title: 'Move to Overwrite', run: () => void vscode.commands.executeCommand(MOVE_TO_OVERWRITE, unmanaged) } : undefined);
    }
    if (result.lost.length > 0) {
      reporter.report('warning', 'Deploy left out each file whose path another file the game gets wins:',
        result.lost.map(({ path, winner }) => `${winner} at ${path}`).join(', '));
    }
    if (result.pluginsTxt.kind === 'notWritten') {
      reporter.report('warning', 'Deploy wrote no plugins.txt:', result.pluginsTxt.why);
    }
    if (result.pluginsTxt.kind !== 'notWritten' && result.pluginsTxt.renamed.length > 0) {
      reporter.report('warning', 'Deploy renamed each plugins.txt it did not write, so the game reads the plugin order of this load order:', result.pluginsTxt.renamed.join(', '));
    }
    if (result.leftAside.length > 0) {
      reporter.report('warning', 'Deploy landed, and could not remove each file it set aside, which the next deploy removes:', result.leftAside.join(', '));
    }
  };
  // The game folder can be the deployment folder (deployment-hardlink.md, story 4), and the instance value reads its Data folder.
  return [
    vscode.commands.registerCommand('modbench.instance.deploy', () => runWritingGesture(TOOLBOX_VIEW, instance, deploy)),
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

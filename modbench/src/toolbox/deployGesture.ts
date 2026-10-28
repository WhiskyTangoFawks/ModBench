import * as vscode from 'vscode';
import type { Instance } from '../instanceLoader/instance';
import type { DeployCommands } from '../instanceCommands/deploy';
import { runWritingGesture } from '../drivingLib/writingGesture';
import type { Reporter } from '../ports/reporter';
import { TOOLBOX_VIEW } from './toolboxCommands';

interface DeployGestureDeps {
  commands: Pick<DeployCommands, 'deploy'>;
  instance: Pick<Instance, 'landed' | 'sequence' | 'refresh'>;
  reporter: Reporter;
}

// deployment-hardlink.md, Deploy, story 7: deploy asks nothing.
export function registerDeployCommand({ commands, instance, reporter }: DeployGestureDeps): vscode.Disposable {
  const deploy = async (): Promise<void> => {
    const { files } = await instance.landed();
    const result = await commands.deploy(instance.sequence === 0 ? undefined : files);
    if (!result.applied) {
      reporter.report('error', 'Could not deploy.', result.refusal);
      return;
    }
    if (result.leftOut.length > 0) {
      reporter.report('warning', 'Deploy left out each file whose path holds a file it did not write:', result.leftOut.join(', '));
    }
    if (result.lost.length > 0) {
      reporter.report('warning', 'Deploy left out each file whose path another file the game gets wins:',
        result.lost.map(({ path, winner }) => `${winner} at ${path}`).join(', '));
    }
  };
  // The game folder can be the deployment folder (deployment-hardlink.md, story 4), and the instance value reads its Data folder.
  return vscode.commands.registerCommand('modbench.instance.deploy', () => runWritingGesture(TOOLBOX_VIEW, instance, deploy));
}

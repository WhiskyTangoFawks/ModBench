import * as vscode from 'vscode';
import type { Instance } from '../instanceLoader/instance';
import type { MasterlistCommands } from '../instanceCommands/masterlist';
import { answeredToAgent, isAgentCall, registerWritingCommand, type NoItemsResult } from '../drivingLib/agentGesture';
import { runWritingGesture } from '../drivingLib/writingGesture';
import type { Reporter } from '../ports/reporter';

const UPDATE_MASTERLIST = 'modbench.instance.updateMasterlist';

interface MasterlistGestureDeps {
  commands: Pick<MasterlistCommands, 'update'>;
  instance: Pick<Instance, 'refresh'>;
  /** The view whose progress shows the update runs. */
  pluginsView: string;
  /** The Plugins view's message line. */
  say: (message: string | undefined) => void;
  reporter: Reporter;
}

const wroteOrCurrent = (written: readonly string[]): string =>
  written.length === 0 ? 'The masterlist was already current.' : `Wrote ${written.join(' and ')}.`;

/** `modbench.instance.updateMasterlist` (commands.md): asks nothing. */
export function registerMasterlistCommand({ commands, instance, pluginsView, say, reporter }: MasterlistGestureDeps): vscode.Disposable {
  const run = async (called: unknown): Promise<NoItemsResult | undefined> => {
    say('Updating the masterlist…');
    try {
      const result = await commands.update();
      if (isAgentCall(called)) return answeredToAgent(result, [], result.applied ? wroteOrCurrent(result.written) : undefined);
      if (!result.applied) reporter.report('error', 'Could not update the masterlist.', result.refusal);
      return undefined;
    } finally {
      say(undefined);
    }
  };
  return registerWritingCommand(UPDATE_MASTERLIST, (called?: unknown) =>
    runWritingGesture(UPDATE_MASTERLIST, pluginsView, instance, () => run(called)));
}

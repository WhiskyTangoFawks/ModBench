import * as vscode from 'vscode';
import type { Instance } from '../instanceLoader/instance';
import type { MasterlistCommands } from '../instanceCommands/masterlist';
import { answeredToAgent, isAgentCall, type AgentCall, type GestureResult } from '../drivingLib/agentGesture';
import type { Progress } from '../drivingLib/pausableProgress';
import { runWritingGesture } from '../drivingLib/writingGesture';
import type { AskQuestion } from '../ports/dialog';
import type { Reporter } from '../ports/reporter';

const UPDATE_MASTERLIST = 'modbench.instance.updateMasterlist';
const CONFIRM = 'Update masterlist';

interface MasterlistGestureDeps {
  commands: Pick<MasterlistCommands, 'update' | 'uncommitted'>;
  instance: Pick<Instance, 'refresh'>;
  /** The view whose progress shows the update runs. */
  pluginsView: string;
  /** The Plugins view's message line. */
  say: (message: string | undefined) => void;
  ask: AskQuestion;
  reporter: Reporter;
}

const forces = (call: AgentCall): boolean => 'force' in call.options && call.options.force === true;

/** `modbench.instance.updateMasterlist` (commands.md): asks first, or refuses an agent without force, only over uncommitted changes. */
export function registerMasterlistCommand({ commands, instance, pluginsView, say, ask, reporter }: MasterlistGestureDeps): vscode.Disposable {
  const run = async (called: unknown, progress: Progress): Promise<GestureResult<never, string> | undefined> => {
    const agentCall = isAgentCall(called) ? called : undefined;
    const finish = (result: { applied: true } | { applied: false; refusal: string }) => {
      if (agentCall) return answeredToAgent(result);
      if (!result.applied) reporter.report('error', 'Could not update the masterlist.', result.refusal);
      return undefined;
    };
    const held = await commands.uncommitted();
    if (!held.applied) return finish(held);
    if (held.files.length > 0 && !(agentCall && forces(agentCall))) {
      const files = held.files.join(', ');
      if (agentCall) {
        return { applied: false, refusal: `The masterlist has uncommitted changes to ${files}, which updating would replace. Request it again with force to update it.` };
      }
      progress.waiting();
      const answer = await ask(`Update the masterlist? It replaces uncommitted changes to ${files}.`, { modal: true }, CONFIRM);
      progress.working();
      if (answer !== CONFIRM) return undefined;
    }
    say('Updating the masterlist…');
    try {
      return finish(await commands.update());
    } finally {
      say(undefined);
    }
  };
  return vscode.commands.registerCommand(UPDATE_MASTERLIST, (called?: unknown) =>
    runWritingGesture(pluginsView, instance, (progress) => run(called, progress)));
}

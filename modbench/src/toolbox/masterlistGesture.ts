import * as vscode from 'vscode';
import type { Instance } from '../instanceLoader/instance';
import type { MasterlistCommands } from '../instanceCommands/masterlist';
import { answeredToAgent, isAgentCall, type AgentCall, type GestureResult } from '../drivingLib/agentGesture';
import { runWritingGesture } from '../drivingLib/writingGesture';
import type { AskQuestion } from '../ports/dialog';
import type { Reporter } from '../ports/reporter';

const UPDATE_MASTERLIST = 'modbench.instance.updateMasterlist';
const CONFIRM = 'Update masterlist';

interface MasterlistGestureDeps {
  commands: Pick<MasterlistCommands, 'update' | 'uncommitted'>;
  instance: Pick<Instance, 'refresh'>;
  /** The Plugins view, whose message line says the update runs. */
  pluginsView: string;
  say: (message: string | undefined) => void;
  ask: AskQuestion;
  reporter: Reporter;
}

const forces = (call: AgentCall): boolean => 'force' in call.options && call.options.force === true;

/** `modbench.instance.updateMasterlist` (commands.md): asks first, or refuses an agent without force, only over uncommitted changes. */
export function registerMasterlistCommand({ commands, instance, pluginsView, say, ask, reporter }: MasterlistGestureDeps): vscode.Disposable {
  const run = async (called: unknown): Promise<GestureResult<never, string> | undefined> => {
    const agentCall = isAgentCall(called) ? called : undefined;
    const changed = await commands.uncommitted();
    if (changed.length > 0 && !(agentCall && forces(agentCall))) {
      const files = changed.join(', ');
      if (agentCall) {
        return { applied: false, refusal: `The masterlist has uncommitted changes to ${files}, which updating would replace. Request it again with force to update it.` };
      }
      if (await ask(`Update the masterlist? It replaces uncommitted changes to ${files}.`, { modal: true }, CONFIRM) !== CONFIRM) return undefined;
    }
    say('Updating the masterlist…');
    let result;
    try {
      result = await commands.update();
    } finally {
      say(undefined);
    }
    if (agentCall) return answeredToAgent(result);
    if (!result.applied) reporter.report('error', 'Could not update the masterlist.', result.refusal);
    return undefined;
  };
  return vscode.commands.registerCommand(UPDATE_MASTERLIST, (called?: unknown) => runWritingGesture(pluginsView, instance, () => run(called)));
}

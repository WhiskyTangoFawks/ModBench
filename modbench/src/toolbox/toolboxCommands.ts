import * as vscode from 'vscode';
import type { RefreshResult } from '../instanceCommands/loadOrder';
import type { Instance } from '../instanceLoader/instance';
import type { InstanceCommands } from '../instanceCommands/instanceCommands';
import { AgentCall, answeredToAgent, isAgentCall, profilesOf, type GestureResult } from '../drivingLib/agentGesture';
import { pickWithMarked } from '../drivingLib/pickWithMarked';
import { runWritingGesture } from '../drivingLib/writingGesture';
import { Refusal } from '../drivingLib/refusal';
import type { Reporter } from '../ports/reporter';

export const TOOLBOX_VIEW = 'modbench.toolbox';

interface ToolboxCommandDeps {
  commands: Pick<InstanceCommands, 'switchProfile'>;
  /** The profiles and the active one, from the instance value (ADR-0015); `refresh` ends each gesture. */
  instance: Pick<Instance, 'value' | 'refresh'>;
  /** Modbench's own extension ID, which scopes the Settings editor to its settings. */
  extensionId: string;
  reporterFor: (tag: string) => Reporter;
}

function profileOf(call: AgentCall): string {
  const [only, ...more] = profilesOf(call);
  if (only === undefined || more.length > 0) throw new Refusal('Switching takes the one profile to switch to.');
  return only;
}

// The instance-wide gestures the Toolbox view owns (toolbox.md), registered
// for the box that draws them.
export function registerToolboxCommands(deps: ToolboxCommandDeps): vscode.Disposable[] {
  const { commands, instance, extensionId, reporterFor } = deps;
  const profileReporter = reporterFor('switchProfile');
  return [
    vscode.commands.registerCommand('modbench.profile.switch', async (called?: unknown) => {
      if (isAgentCall(called)) return answeredToAgent(await runWritingGesture(TOOLBOX_VIEW, instance, () => commands.switchProfile(profileOf(called))));
      const { activeProfile: active, profiles } = instance.value;
      const items = profiles.map((p) => ({ label: p, description: p === active ? 'current' : undefined }));
      const picked = await pickWithMarked(items, items.find((i) => i.label === active), 'Switch profile');
      if (!picked || picked.label === active) return undefined;
      await runWritingGesture(TOOLBOX_VIEW, instance, async () => {
        const outcome = await commands.switchProfile(picked.label);
        if (!outcome.applied) profileReporter.report('error', 'Failed to switch profile.', outcome.refusal);
      });
      return undefined;
    }),
    vscode.commands.registerCommand('modbench.settings.open', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${extensionId}`)),
    vscode.commands.registerCommand('modbench.settings.openDeploymentFolderHere', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', 'modbench.deployment.folder')),
  ];
}

interface RefreshGestureDeps {
  commands: Pick<InstanceCommands, 'refresh'>;
  /** Armed before the rebuild is asked for: `ended` settles once mEdit's refill ends, since the
   *  rebuild answers before it has read anything again. A refused rebuild starts no refill, so its
   *  wait is released. */
  nextRefill: () => { ended: Promise<void>; release: () => void };
  instance: Pick<Instance, 'value' | 'refresh'>;
  reporterFor: (tag: string) => Reporter;
  /** Names this instance in toolbox.md's Reporting story 1. Modbench cannot name the other
   *  window that holds the record index, only the one refused here. */
  instanceRoot: string;
}

export function registerRefreshCommand(deps: RefreshGestureDeps): vscode.Disposable {
  const reporter = deps.reporterFor('refresh');
  const refusalOf = (outcome: Extract<RefreshResult, { applied: false }>) => outcome.heldElsewhere
    ? { message: 'This instance is open in another Modbench window. Close it, then refresh.', detail: deps.instanceRoot }
    : { message: 'Could not refresh.', detail: outcome.refusal };
  const run = async (fromAgent: boolean): Promise<GestureResult<never, string> | undefined> => {
    const refill = deps.nextRefill();
    const outcome = await deps.commands.refresh();
    if (outcome.applied) {
      await refill.ended;
      return fromAgent ? answeredToAgent(outcome) : undefined;
    }
    refill.release();
    const { message, detail } = refusalOf(outcome);
    if (fromAgent) return { applied: false, refusal: message, detail };
    reporter.report('error', message, detail);
    return undefined;
  };
  return vscode.commands.registerCommand('modbench.instance.refresh', (called?: unknown) =>
    runWritingGesture(TOOLBOX_VIEW, deps.instance, () => run(called instanceof AgentCall)));
}

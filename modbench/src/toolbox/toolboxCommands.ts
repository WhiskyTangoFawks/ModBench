import * as vscode from 'vscode';
import type { Instance } from '../instanceLoader/instance';
import type { InstanceCommands } from '../instanceCommands/instanceCommands';
import { AgentCall, answeredToAgent, isAgentCall, registerWritingCommand, profilesOf } from '../drivingLib/agentGesture';
import { pickWithMarked } from '../drivingLib/pickWithMarked';
import { runWritingGesture } from '../drivingLib/writingGesture';
import { Refusal } from '../drivingLib/refusal';
import type { Reporter } from '../ports/reporter';

export const TOOLBOX_VIEW = 'modbench.toolbox';

interface ToolboxCommandDeps {
  commands: Pick<InstanceCommands, 'switchProfile'>;
  /** The profiles and the active one, from the instance value; `refresh` ends each gesture. */
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
    registerWritingCommand('modbench.profile.switch', async (called?: unknown) => {
      if (isAgentCall(called)) {
        const profile = profileOf(called);
        return answeredToAgent(await runWritingGesture('modbench.profile.switch', TOOLBOX_VIEW, instance, () => commands.switchProfile(profile)), [], `Switched to ${profile}.`);
      }
      const { activeProfile: active, profiles } = instance.value;
      const items = profiles.map((p) => ({ label: p, description: p === active ? 'current' : undefined }));
      const picked = await pickWithMarked(items, items.find((i) => i.label === active), 'Switch profile');
      if (!picked || picked.label === active) return undefined;
      await runWritingGesture('modbench.profile.switch', TOOLBOX_VIEW, instance, async () => {
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
  instance: Pick<Instance, 'refresh'>;
  /** The record index's status as mEdit last published it. */
  loadOrderStatus: () => { readonly refusal?: { readonly kind: 'heldElsewhere' | 'failed' } } | undefined;
  reporterFor: (tag: string) => Reporter;
  instanceRoot: string;
  /** Whether mEdit is up to take the check. */
  mEditStatus: () => 'starting' | 'running' | 'disconnected' | 'stopped';
}

const heldElsewhereMessage = (then: string): string => `This instance is open in another Modbench window. Close it, then ${then}.`;

export function registerRefreshCommand(deps: RefreshGestureDeps): vscode.Disposable {
  const reporter = deps.reporterFor('refresh');
  const message = heldElsewhereMessage('refresh');
  const unchecked = 'Checked the instance, but not the index: mEdit is not running.';
  return registerWritingCommand('modbench.instance.refresh', async (called?: unknown) => {
    await runWritingGesture('modbench.instance.refresh', TOOLBOX_VIEW, deps.instance, (_progress, written) => {
      written.leaveUnnamed();
      return Promise.resolve();
    });
    const fromAgent = called instanceof AgentCall;
    if (deps.mEditStatus() !== 'running') {
      if (fromAgent) return { applied: false, refusal: unchecked };
      reporter.report('error', unchecked);
      return undefined;
    }
    if (deps.loadOrderStatus()?.refusal?.kind === 'heldElsewhere') {
      if (fromAgent) return { applied: false, refusal: message, detail: deps.instanceRoot };
      reporter.report('error', message, deps.instanceRoot);
      return undefined;
    }
    return fromAgent ? answeredToAgent({ applied: true }) : undefined;
  });
}

interface RebuildGestureDeps {
  commands: Pick<InstanceCommands, 'rebuildRecordIndex'>;
  /** Armed before the rebuild is asked for: `ended` settles once mEdit's refill ends, since the
   *  rebuild answers before it has read anything again. A refused rebuild starts no refill, so its
   *  wait is released. */
  nextRefill: () => { ended: Promise<void>; release: () => void };
  instance: Pick<Instance, 'refresh'>;
  reporterFor: (tag: string) => Reporter;
  /** Names this instance in a refusal: Modbench cannot name the other window that holds the record index. */
  instanceRoot: string;
}

export function registerRebuildRecordIndexCommand(deps: RebuildGestureDeps): vscode.Disposable {
  const reporter = deps.reporterFor('rebuildRecordIndex');
  return registerWritingCommand('modbench.instance.rebuildRecordIndex', () =>
    runWritingGesture('modbench.instance.rebuildRecordIndex', TOOLBOX_VIEW, deps.instance, async () => {
      const refill = deps.nextRefill();
      const outcome = await deps.commands.rebuildRecordIndex();
      if (outcome.applied) {
        await refill.ended;
        return;
      }
      refill.release();
      if (outcome.heldElsewhere) reporter.report('error', heldElsewhereMessage('rebuild the index'), deps.instanceRoot);
      else reporter.report('error', 'Could not rebuild the index.', outcome.refusal);
    }));
}

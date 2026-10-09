import * as vscode from 'vscode';
import type { Instance } from '../instanceLoader/instance';
import type { InstanceCommands } from '../instanceCommands/instanceCommands';
import { pickWithMarked } from '../drivingLib/pickWithMarked';
import { runWritingGesture } from '../drivingLib/writingGesture';
import type { Reporter } from '../ports/reporter';

const TOOLBOX_VIEW = 'modbench.toolbox';

interface ToolboxCommandDeps {
  commands: Pick<InstanceCommands, 'switchProfile'>;
  /** The profiles and the active one, from the instance value (ADR-0015); `refresh` ends each gesture. */
  instance: Pick<Instance, 'value' | 'refresh'>;
  /** Modbench's own extension ID, which scopes the Settings editor to its settings. */
  extensionId: string;
  reporterFor: (tag: string) => Reporter;
}

// The instance-wide gestures the Toolbox view owns (toolbox.md), registered
// for the box that draws them.
export function registerToolboxCommands(deps: ToolboxCommandDeps): vscode.Disposable[] {
  const { commands, instance, extensionId, reporterFor } = deps;
  const profileReporter = reporterFor('switchProfile');
  return [
    vscode.commands.registerCommand('modbench.profile.switch', async () => {
      const { activeProfile: active, profiles } = instance.value;
      const items = profiles.map((p) => ({ label: p, description: p === active ? 'current' : undefined }));
      const picked = await pickWithMarked(items, items.find((i) => i.label === active), 'Switch profile');
      if (!picked || picked.label === active) return;
      await runWritingGesture(TOOLBOX_VIEW, instance, async () => {
        const outcome = await commands.switchProfile(picked.label, profiles);
        if (!outcome.applied) profileReporter.report('error', 'Failed to switch profile.', outcome.refusal);
      });
    }),
    vscode.commands.registerCommand('modbench.settings.open', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${extensionId}`)),
  ];
}

interface RefreshGestureDeps {
  commands: Pick<InstanceCommands, 'refresh'>;
  /** Armed before the rebuild is asked for: `ended` settles once mEdit's refill ends, since the
   *  rebuild answers before it has read anything again. A refused rebuild starts no refill, so its
   *  wait is released. */
  nextRefill: () => { ended: Promise<void>; release: () => void };
  instance: Pick<Instance, 'value' | 'refresh'>;
  reporter: Reporter;
  /** Names this instance in toolbox.md's Reporting story 1 — Modbench cannot name the other
   *  window that holds the index, only the one refused here. */
  instanceRoot: string;
}

export function registerRefreshCommand(deps: RefreshGestureDeps): vscode.Disposable {
  const run = async (): Promise<void> => {
    const refill = deps.nextRefill();
    const outcome = await deps.commands.refresh(deps.instance.value);
    if (!outcome.applied) {
      if (outcome.heldElsewhere) {
        // toolbox.md, Reporting story 1: the spec's own words, naming this instance.
        deps.reporter.report('error', "This instance's index is open in another Modbench window", deps.instanceRoot);
      } else {
        deps.reporter.report('error', 'Could not rebuild the index.', outcome.refusal);
      }
      refill.release();
      return;
    }
    await refill.ended;
  };
  return vscode.commands.registerCommand('modbench.instance.refresh', () =>
    runWritingGesture(TOOLBOX_VIEW, deps.instance, run));
}

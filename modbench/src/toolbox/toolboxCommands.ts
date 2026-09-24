import * as vscode from 'vscode';
import type { Instance } from '../instanceLoader/instance';
import { switchProfile } from '../instanceCommands/profile';
import type { RefreshResult } from '../instanceCommands/loadOrder';
import type { Reporter } from '../ports/reporter';

export interface ToolboxCommandDeps {
  instanceRoot: string;
  /** ADR-0015: the profiles and the active one come from the value. */
  instance: Pick<Instance, 'value'>;
  /** Modbench's own extension ID, which scopes the Settings editor to its settings. */
  extensionId: string;
  reporterFor: (tag: string) => Reporter;
}

// The instance-wide gestures the Toolbox view owns (toolbox.md), registered
// for the box that draws them.
export function registerToolboxCommands(deps: ToolboxCommandDeps): vscode.Disposable[] {
  const { instanceRoot, instance, extensionId, reporterFor } = deps;
  const profileReporter = reporterFor('switchProfile');
  return [
    vscode.commands.registerCommand('modbench.profile.switch', async () => {
      const { activeProfile: active, profiles } = instance.value;
      const picked = await vscode.window.showQuickPick(
        profiles.map((p) => ({ label: p, description: p === active ? 'current' : undefined })),
        { placeHolder: 'Switch profile' },
      );
      if (!picked || picked.label === active) return;
      const outcome = await switchProfile(instanceRoot, picked.label, profiles);
      if (!outcome.applied) profileReporter.report('error', 'Failed to switch profile.', outcome.refusal);
    }),
    vscode.commands.registerCommand('modbench.settings.open', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${extensionId}`)),
  ];
}

export interface RefreshGestureDeps {
  /** instance commands' refresh, bound by the root to the mEdit client and the current value. */
  refresh: () => Promise<RefreshResult>;
  /** Armed before the rebuild is asked for: settles once mEdit's refill ends, since the rebuild
   *  answers before it has read anything again. */
  nextRefill: () => Promise<void>;
  instance: Pick<Instance, 'refresh'>;
  reporter: Reporter;
  /** Names this instance in toolbox.md's Reporting story 1 — Modbench cannot name the other
   *  window that holds the index, only the one refused here. */
  instanceRoot: string;
}

export function registerRefreshCommand(deps: RefreshGestureDeps): vscode.Disposable {
  const run = async (): Promise<void> => {
    const refilled = deps.nextRefill();
    const outcome = await deps.refresh();
    if (!outcome.applied) {
      if (outcome.heldElsewhere) {
        // toolbox.md, Reporting story 1: the spec's own words, naming this instance.
        deps.reporter.report('error', "This instance's index is open in another Modbench window", deps.instanceRoot);
      } else {
        deps.reporter.report('error', 'Could not rebuild the index.', outcome.refusal);
      }
      return;
    }
    await refilled;
    const rereadFailure = await deps.instance.refresh();
    if (rereadFailure !== undefined) deps.reporter.report('error', 'Could not read the instance again.', rereadFailure);
  };
  return vscode.commands.registerCommand('modbench.instance.refresh', () =>
    vscode.window.withProgress({ location: { viewId: 'modbench.toolbox' } }, run));
}

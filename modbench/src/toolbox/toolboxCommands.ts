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

// The instance-wide gestures the Toolbox view owns (docs/specs/containers.md rule 1), registered
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
  instance: Pick<Instance, 'refresh'>;
  reporter: Reporter;
}

export function registerRefreshCommand(deps: RefreshGestureDeps): vscode.Disposable {
  const run = async (): Promise<void> => {
    const outcome = await deps.refresh();
    if (!outcome.applied) {
      deps.reporter.report('error', 'Could not rebuild the index.', outcome.refusal);
      return;
    }
    const rereadFailure = await deps.instance.refresh();
    if (rereadFailure !== undefined) deps.reporter.report('error', 'Could not read the instance again.', rereadFailure);
  };
  return vscode.commands.registerCommand('modbench.instance.refresh', () =>
    vscode.window.withProgress({ location: { viewId: 'modbench.toolbox' } }, run));
}

import * as vscode from 'vscode';
import type { Instance } from '../instanceLoader/instance';
import { switchProfile } from '../instanceCommands/profile';
import type { RefreshResult } from '../instanceCommands/loadOrder';
import type { Reporter } from '../ports/reporter';

export interface ToolboxCommandDeps {
  instanceRoot: string;
  /** ADR-0015: the profiles and the active one come from the value. */
  instance: Pick<Instance, 'value'>;
  updateProfileDescription: () => Promise<void>;
  reporterFor: (tag: string) => Reporter;
}

// The instance-wide gestures the Toolbox view owns (docs/specs/containers.md rule 1), registered
// for the box that draws them.
export function registerToolboxCommands(deps: ToolboxCommandDeps): vscode.Disposable[] {
  const { instanceRoot, instance, updateProfileDescription, reporterFor } = deps;
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
      if (!outcome.applied) {
        profileReporter.report('error', 'Failed to switch profile.', outcome.refusal);
        return;
      }
      void updateProfileDescription();
      // ADR-0013/ADR-0015: the write lands in ModOrganizer.ini, which the Instance already
      // watches — its own recompute reaches the load order and the Toolbox's profile row.
    }),
  ];
}

export interface RefreshGestureDeps {
  /** instance commands' refresh, bound by the root to the mEdit client and the current value. */
  refresh: () => Promise<RefreshResult>;
  instance: Pick<Instance, 'refresh'>;
  reporter: Reporter;
}

// One gesture for all of Modbench, and only the safety net for a missed watcher event. Undefined
// deps with no instance open: the title icon still shows, so the command exists and does nothing.
export function registerRefreshCommand(deps: RefreshGestureDeps | undefined): vscode.Disposable {
  return vscode.commands.registerCommand('modbench.instance.refresh', async () => {
    if (!deps) return;
    const outcome = await deps.refresh();
    if (!outcome.applied) {
      deps.reporter.report('error', 'Could not rebuild the index.', outcome.refusal);
      return;
    }
    await deps.instance.refresh();
  });
}

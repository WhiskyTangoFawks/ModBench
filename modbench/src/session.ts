import * as vscode from 'vscode';
import type { MinimalRepository } from './plugins/pluginRowCommands';
import type { PluginsTreeNode, PluginsTreeProvider } from './plugins/PluginsTreeProvider';
import type { LoadOrderSync } from './loadOrderReconcile';
import type { NameFilter } from './nameFilter';
import { say } from './editingTeardown';

/** Records a disposable against its owner's teardown and hands it back. The Toolbox's one way
 *  in: `src/test/toolboxScan.test.ts` fails on a registration that skips it. */
export type Own = <T extends vscode.Disposable>(disposable: T) => T;

// Everything activation constructs that a choke point registered elsewhere must also reach —
// one object rather than nine module-level singletons. `undefined` until the wiring reaches the
// field; every reader treats "not yet built" and "no live workspace" alike.
export interface ExtensionSession {
  pluginsTree?: PluginsTreeProvider;
  /** ADR-0044: the one path by which the Plugin load order reaches Editing. */
  loadOrderSync?: LoadOrderSync;
  /** The same view, as a `TreeView` — carries the load's own progress and incompleteness
   *  statement (`TreeView.message`, via `say`). */
  pluginsTreeView?: vscode.TreeView<PluginsTreeNode>;
  /** The same view's name filter — a second, independent narrowing axis from the record filter,
   *  which has to be able to add itself to this view's readout. */
  pluginsNameFilter?: NameFilter;
  /** Plugin filename → the `vscode.git` `Repository` for that plugin's mod folder. Kept so a
   *  successful field edit can prompt that repository's `status()` and make the Source Control
   *  panel pick up the working-tree change without a manual Refresh. */
  pluginRepositories?: Map<string, MinimalRepository>;
  /** The record filter's single writer: the context key its Clear action is gated on, the code
   *  lens's active SQL, and the readout. */
  setFilterActive?: (active: boolean, sql?: string, label?: string) => void;
  /** The malformed-plugin scan's Problems entries, replaced wholesale by each reconcile. */
  loadDiagnostics?: vscode.DiagnosticCollection;
}

// ADR-0035: one progress indicator, in the view whose contents are loading — not a per-command
// `ProgressLocation.Notification`. The message clears on every exit path, so no failure leaves
// the view claiming a load that is not running.
export function withPluginsViewProgress(session: ExtensionSession, work: () => Promise<void>): Promise<void> {
  return Promise.resolve(vscode.window.withProgress(
    { location: { viewId: 'modbench.pluginListTree' } },
    async () => { try { await work(); } finally { say(session, undefined); } },
  ));
}

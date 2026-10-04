import * as vscode from 'vscode';
import type { MinimalRepository } from './plugins/pluginRowCommands';
import type { PluginsView } from './plugins/pluginsView';
import type { LoadOrderSender } from './client';

/** Records a disposable against its owner's teardown and hands it back. The Toolbox's one way
 *  in: `src/test/toolboxScan.test.ts` fails on a registration that skips it. */
export type Own = <T extends vscode.Disposable>(disposable: T) => T;

// Everything activation constructs that a choke point registered elsewhere must also reach —
// one object rather than nine module-level singletons. `undefined` until the wiring reaches the
// field; every reader treats "not yet built" and "no live workspace" alike.
export interface ExtensionSession {
  plugins?: PluginsView;
  /** The one sender of ADR-0013's snapshot. */
  loadOrderSender?: LoadOrderSender;
  /** Plugin filename → the `vscode.git` `Repository` for that plugin's mod folder. Kept so a
   *  successful field edit can prompt that repository's `status()` and make the Source Control
   *  panel pick up the working-tree change without a manual Refresh. */
  pluginRepositories?: Map<string, MinimalRepository>;
}

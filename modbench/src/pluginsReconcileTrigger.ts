import type * as vscode from 'vscode';
import type { Instance } from './instance/instance';
import { providedPluginsOf, type DataFolderPlugins } from './instance/loadOrderSnapshot';

// Termination: a write re-enters through this subscription, since the Instance watches
// plugins.txt and its value runs the reconcile. The next run changes nothing, writes nothing,
// and the loop stops; a reconcile that wrote unconditionally would never end it.
export function registerPluginsReconcile(
  instance: Pick<Instance, 'subscribe'>,
  run: (
    profile: string, provided: ReadonlyMap<string, string>, inData: DataFolderPlugins,
    dataFolder: string | undefined, gameName: string,
  ) => Promise<unknown>,
): vscode.Disposable {
  return instance.subscribe((value) =>
    void run(
      value.activeProfile, providedPluginsOf(value.plugins), value.dataFolderPlugins,
      value.gameDirectory?.dataFolder, value.gameRelease));
}

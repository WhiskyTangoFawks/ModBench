import type * as vscode from 'vscode';
import type { Instance } from './instanceLoader/instance';
import { providedPluginsOf, type DataFolderPlugins } from './instanceLoader/loadOrderSnapshot';
import { errorMessage } from './ports/errorMessage';

// Stated structurally: the context-boundary scan reads the `plugins` in `pluginsCommands/plugins`
// as the Plugins view's directory.
type PluginSyncOutcome =
  | { applied: true; added: readonly string[]; dropped: readonly string[] }
  | { applied: false; refusal: string };

// Termination: a write re-enters through this subscription, since the Instance watches
// plugins.txt and its value runs plugin sync. The next run changes nothing, writes nothing,
// and the loop stops; a sync that wrote unconditionally would never end it.
export function registerPluginSync(
  instance: Pick<Instance, 'subscribe'>,
  sync: (
    profile: string, provided: ReadonlyMap<string, string>, inData: DataFolderPlugins,
    dataFolder: string | undefined, gameName: string,
  ) => Promise<PluginSyncOutcome>,
  channel: { error(msg: string): void; info(msg: string): void },
): vscode.Disposable {
  return instance.subscribe((value) => {
    void (async () => {
      try {
        const outcome = await sync(
          value.activeProfile, providedPluginsOf(value.plugins), value.dataFolderPlugins,
          value.gameDirectory?.dataFolder, value.gameRelease);
        if (!outcome.applied) {
          channel.error(`[modmanager] plugin sync failed: ${outcome.refusal}`);
          return;
        }
        if (outcome.added.length > 0) {
          channel.info(`[modmanager] plugin sync added ${outcome.added.length} disabled plugins.txt line(s) for plugin(s) on disk with no line: ${outcome.added.join(', ')}`);
        }
        if (outcome.dropped.length > 0) {
          channel.info(`[modmanager] plugin sync dropped ${outcome.dropped.length} plugins.txt line(s) with no plugin on disk: ${outcome.dropped.join(', ')}`);
        }
      } catch (err) {
        channel.error(`[modmanager] plugin sync failed: ${errorMessage(err)}`);
      }
    })();
  });
}

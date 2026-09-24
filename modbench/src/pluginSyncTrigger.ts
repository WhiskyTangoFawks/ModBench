import type * as vscode from 'vscode';
import type { Instance, InstanceValue } from './instanceLoader/instance';
import { providedPluginsOf, type DataFolderPlugins } from './instanceLoader/loadOrderSnapshot';
import { dataFolderOf } from './instanceAdapter/gameDirectory';
import { reportSyncFailures } from './syncFailureReport';

// Stated structurally: the context-boundary scan reads the `plugins` in `pluginsCommands/plugins`
// as the Plugins view's directory.
type PluginSyncOutcome =
  | { applied: true; added: readonly string[]; dropped: readonly string[] }
  | { applied: false; refusal: string };

export interface PluginSyncTrigger extends vscode.Disposable {
  /** The Plugins view's message line for a failed run, until a run lands. */
  message(): string | undefined;
  /** Runs on the current value: mEdit answers which plugins load with no line, and the first
   *  value lands before it can. */
  runOnConnect(): void;
}

// Termination: a write re-enters through this subscription, since the Instance watches
// plugins.txt and its value runs plugin sync. The next run changes nothing, writes nothing,
// and the loop stops; a sync that wrote unconditionally would never end it.
export function registerPluginSync(
  instance: Pick<Instance, 'subscribe' | 'value'>,
  sync: (
    profile: string, provided: ReadonlyMap<string, string>, inData: DataFolderPlugins,
    dataFolder: string | undefined, gameName: string,
  ) => Promise<PluginSyncOutcome>,
  channel: { error(msg: string): void; info(msg: string): void },
  messageChanged: () => void,
): PluginSyncTrigger {
  const failures = reportSyncFailures('plugin sync', 'plugins.txt is not synced', (line) => channel.error(line), messageChanged);
  const run = (value: InstanceValue): void => {
    void (async () => {
      const outcome = await failures.run(() => sync(
        value.activeProfile, providedPluginsOf(value.plugins), value.dataFolderPlugins,
        dataFolderOf(value.gameFolder), value.gameRelease));
      if (outcome === undefined) return;
      if (outcome.added.length > 0) {
        channel.info(`[modmanager] plugin sync added ${outcome.added.length} disabled plugins.txt line(s) for plugin(s) on disk with no line: ${outcome.added.join(', ')}`);
      }
      if (outcome.dropped.length > 0) {
        channel.info(`[modmanager] plugin sync dropped ${outcome.dropped.length} plugins.txt line(s) with no plugin on disk: ${outcome.dropped.join(', ')}`);
      }
    })();
  };
  const subscription = instance.subscribe(run);
  return {
    message: () => failures.message(),
    runOnConnect: () => run(instance.value),
    dispose: () => { subscription.dispose(); },
  };
}

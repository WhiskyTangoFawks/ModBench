import type * as vscode from 'vscode';
import type { Instance, InstanceValue } from './instanceLoader/instance';
import { providedPluginsOf, type DataFolderPlugins } from './instanceLoader/loadOrderSnapshot';
import { reportSyncFailures, trackSyncRuns, type SyncRuns } from './syncFailureReport';
import type { SyncMessage } from './drivingLib/nameFilter';

// Stated structurally: the context-boundary scan reads the `plugins` in `pluginsCommands/plugins`
// as the Plugins view's directory.
type PluginSyncOutcome =
  | { applied: true; added: readonly string[]; dropped: readonly string[] }
  | { applied: false; refusal: string }
  | { applied: false; toldAsInstanceState: true };

/** Plugin sync's inputs, projected off the instance value that is its Argument (commands.md, The
 *  system commands). */
export interface PluginSyncArguments {
  profile: string;
  provided: ReadonlyMap<string, string>;
  inData: DataFolderPlugins;
  loadedWithNoLine: readonly string[] | undefined;
}

export function pluginSyncArguments(value: InstanceValue): PluginSyncArguments {
  return {
    profile: value.activeProfile,
    provided: providedPluginsOf(value.plugins),
    inData: value.dataFolderPlugins,
    loadedWithNoLine: value.pluginsLoadedWithNoLine?.map((plugin) => plugin.name),
  };
}

/** Its message is the Plugins view's, for a failed run until a run lands. */
export type PluginSyncTrigger = vscode.Disposable & SyncMessage & SyncRuns;

// Termination: a write re-enters here through the Instance adapter's signal. The next run changes
// nothing, writes nothing, and the loop stops; a sync that wrote unconditionally never would.
export function registerPluginSync(
  instance: Pick<Instance, 'subscribe'>,
  sync: (value: InstanceValue) => Promise<PluginSyncOutcome>,
  channel: { error(msg: string): void; info(msg: string): void },
): PluginSyncTrigger {
  const failures = reportSyncFailures('plugin sync', 'plugins.txt is not synced', (line) => channel.error(`[pluginsCommands] ${line}`));
  const runs = trackSyncRuns();
  const run = (value: InstanceValue): void => {
    runs.begin((async () => {
      const outcome = await failures.run(() => sync(value));
      if (outcome === undefined) return;
      if (outcome.added.length > 0) {
        channel.info(`[pluginsCommands] plugin sync added ${outcome.added.length} disabled plugins.txt line(s) for plugin(s) on disk with no line: ${outcome.added.join(', ')}`);
      }
      if (outcome.dropped.length > 0) {
        channel.info(`[pluginsCommands] plugin sync dropped ${outcome.dropped.length} plugins.txt line(s) with no plugin on disk: ${outcome.dropped.join(', ')}`);
      }
    })());
  };
  const subscription = instance.subscribe(run);
  return {
    message: () => failures.message(),
    onMessageChanged: (listener) => failures.onMessageChanged(listener),
    settled: () => runs.settled(),
    dispose: () => { subscription.dispose(); },
  };
}

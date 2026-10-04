import type { SyncMessage } from '../drivingLib/nameFilter';
import { reportSyncFailures, trackSyncRuns, type SyncRuns } from '../drivingLib/syncFailureReport';
import type { PluginSyncArguments } from '../instanceLoader/instance';

// Stated structurally: the context-boundary scan reads the `plugins` in `pluginsCommands/plugins`
// as the Plugins view's directory.
type PluginSyncOutcome =
  | { applied: true; added: readonly string[]; dropped: readonly string[] }
  | { applied: false; refusal: string }
  | { applied: false; toldAsInstanceState: true };

/** Plugin sync's runs and its failure, whose message is the Plugins view's, until a run lands. */
export interface PluginSync extends SyncMessage, SyncRuns {
  /** Resolves once this run has told what it did. */
  run(args: PluginSyncArguments): Promise<void>;
}

export function createPluginSync(
  sync: (args: PluginSyncArguments) => Promise<PluginSyncOutcome>,
  channel: { error(msg: string): void; info(msg: string): void },
): PluginSync {
  const failures = reportSyncFailures('plugin sync', 'plugins.txt is not synced', (line) => channel.error(`[pluginsCommands] ${line}`));
  const runs = trackSyncRuns();
  return {
    run: (args) => {
      const run = (async () => {
        const outcome = await failures.run(() => sync(args));
        if (outcome === undefined) return;
        if (outcome.added.length > 0) {
          channel.info(`[pluginsCommands] plugin sync added ${outcome.added.length} disabled plugins.txt line(s) for plugin(s) on disk with no line: ${outcome.added.join(', ')}`);
        }
        if (outcome.dropped.length > 0) {
          channel.info(`[pluginsCommands] plugin sync dropped ${outcome.dropped.length} plugins.txt line(s) with no plugin on disk: ${outcome.dropped.join(', ')}`);
        }
      })();
      runs.begin(run);
      return run;
    },
    message: () => failures.message(),
    onMessageChanged: (listener) => failures.onMessageChanged(listener),
    settled: () => runs.settled(),
  };
}

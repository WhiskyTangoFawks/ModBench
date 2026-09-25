import type * as vscode from 'vscode';
import type { Instance, InstanceValue } from './instanceLoader/instance';
import { reportSyncFailures, trackSyncRuns, type SyncMessage, type SyncRuns } from './syncFailureReport';

// Stated structurally: the context-boundary scan reads the `plugins` in `pluginsCommands/plugins`
// as the Plugins view's directory.
type PluginSyncOutcome =
  | { applied: true; added: readonly string[]; dropped: readonly string[] }
  | { applied: false; refusal: string }
  | { applied: false; toldAsInstanceState: true };

/** Its message is the Plugins view's, for a failed run until a run lands. */
export interface PluginSyncTrigger extends vscode.Disposable, SyncMessage, SyncRuns {
  /** Runs on the current value: mEdit answers which plugins load with no line, and the first
   *  value lands before it can. Until the first call, no landed value runs plugin sync. */
  runOnConnect(): void;
}

// Termination: a write re-enters through this subscription, since the Instance watches
// plugins.txt and its value runs plugin sync. The next run changes nothing, writes nothing,
// and the loop stops; a sync that wrote unconditionally would never end it.
export function registerPluginSync(
  instance: Pick<Instance, 'subscribe' | 'value'>,
  sync: (value: InstanceValue) => Promise<PluginSyncOutcome>,
  channel: { error(msg: string): void; info(msg: string): void },
): PluginSyncTrigger {
  const failures = reportSyncFailures('plugin sync', 'plugins.txt is not synced', (line) => channel.error(line));
  // update-load-order-file, Refusals: before mEdit first attaches, plugin sync waits, so a launch
  // reports nothing.
  let attachedOnce = false;
  const runs = trackSyncRuns();
  const run = (value: InstanceValue): void => {
    runs.begin((async () => {
      const outcome = await failures.run(() => sync(value));
      if (outcome === undefined) return;
      if (outcome.added.length > 0) {
        channel.info(`[modmanager] plugin sync added ${outcome.added.length} disabled plugins.txt line(s) for plugin(s) on disk with no line: ${outcome.added.join(', ')}`);
      }
      if (outcome.dropped.length > 0) {
        channel.info(`[modmanager] plugin sync dropped ${outcome.dropped.length} plugins.txt line(s) with no plugin on disk: ${outcome.dropped.join(', ')}`);
      }
    })());
  };
  const subscription = instance.subscribe((value) => {
    if (attachedOnce) run(value);
  });
  return {
    message: () => failures.message(),
    onMessageChanged: (listener) => failures.onMessageChanged(listener),
    settled: () => runs.settled(),
    runOnConnect: () => {
      attachedOnce = true;
      run(instance.value);
    },
    dispose: () => { subscription.dispose(); },
  };
}

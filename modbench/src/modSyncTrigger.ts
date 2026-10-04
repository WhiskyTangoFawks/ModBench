import type * as vscode from 'vscode';
import type { Instance, InstanceValue } from './instanceLoader/instance';
import type { ModSyncResult } from './modlist/modlist';
import { reportSyncFailures, trackSyncRuns, type SyncRuns } from './syncFailureReport';
import type { SyncMessage } from './drivingLib/nameFilter';

/** Its message is the Mods view's, for a failed run until a run lands. */
export interface ModSyncTrigger extends vscode.Disposable, SyncMessage, SyncRuns {}

// Termination: the write re-enters here through the Instance adapter's signal. The next value
// agrees with the mod folders, so the command writes nothing, which stops the loop.
export function registerModSync(
  instance: Pick<Instance, 'subscribe' | 'value'>,
  sync: (value: InstanceValue) => Promise<ModSyncResult>,
  channel: { error(msg: string): void; info(msg: string): void },
): ModSyncTrigger {
  const { modOrderFile } = instance.value.managerNames;
  const failures = reportSyncFailures('mod sync', `${modOrderFile} is not synced`, (line) => channel.error(`[modlist] ${line}`));
  const runs = trackSyncRuns();
  const subscription = instance.subscribe((value) => {
    runs.begin((async () => {
      const outcome = await failures.run(() => sync(value));
      if (outcome === undefined) return;
      if (outcome.added.length > 0) {
        channel.info(`[modlist] mod sync added ${outcome.added.length} ${modOrderFile} line(s) for folder(s) in mods/ with no line: ${outcome.added.join(', ')}`);
      }
      if (outcome.dropped.length > 0) {
        channel.info(`[modlist] mod sync dropped ${outcome.dropped.length} ${modOrderFile} line(s) whose folder is gone from mods/: ${outcome.dropped.join(', ')}`);
      }
    })());
  });
  return {
    message: () => failures.message(),
    onMessageChanged: (listener) => failures.onMessageChanged(listener),
    settled: () => runs.settled(),
    dispose: () => { subscription.dispose(); },
  };
}

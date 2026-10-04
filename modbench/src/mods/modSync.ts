import type { SyncMessage } from '../drivingLib/nameFilter';
import { reportSyncFailures, trackSyncRuns, type SyncRuns } from '../drivingLib/syncFailureReport';
import type { ModSyncArguments } from '../instanceLoader/instance';
import type { ModSyncResult } from '../modlist/modlist';

/** Mod sync's runs and its failure, whose message is the Mods view's, until a run lands. */
export interface ModSync extends SyncMessage, SyncRuns {
  run(args: ModSyncArguments): void;
}

export function createModSync(
  sync: (args: ModSyncArguments) => Promise<ModSyncResult>,
  channel: { error(msg: string): void; info(msg: string): void },
  modOrderFile: string,
): ModSync {
  const failures = reportSyncFailures('mod sync', `${modOrderFile} is not synced`, (line) => channel.error(`[modlist] ${line}`));
  const runs = trackSyncRuns();
  return {
    run: (args) => {
      runs.begin((async () => {
        const outcome = await failures.run(() => sync(args));
        if (outcome === undefined) return;
        if (outcome.added.length > 0) {
          channel.info(`[modlist] mod sync added ${outcome.added.length} ${modOrderFile} line(s) for folder(s) in mods/ with no line: ${outcome.added.join(', ')}`);
        }
        if (outcome.dropped.length > 0) {
          channel.info(`[modlist] mod sync dropped ${outcome.dropped.length} ${modOrderFile} line(s) whose folder is gone from mods/: ${outcome.dropped.join(', ')}`);
        }
      })());
    },
    message: () => failures.message(),
    onMessageChanged: (listener) => failures.onMessageChanged(listener),
    settled: () => runs.settled(),
  };
}

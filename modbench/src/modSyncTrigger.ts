import type * as vscode from 'vscode';
import type { Instance } from './instanceLoader/instance';
import type { ModSyncResult } from './modlist/modlist';
import { reportSyncFailures, type SyncMessage } from './syncFailureReport';

/** Its message is the Mods view's, for a failed run until a run lands. */
export interface ModSyncTrigger extends vscode.Disposable, SyncMessage {}

// Termination: the write re-enters here, since the Instance watches modlist.txt. The next value
// agrees with mods/, so the command writes nothing, which stops the loop.
export function registerModSync(
  instance: Pick<Instance, 'subscribe'>,
  sync: (profile: string, modFolders: readonly string[] | undefined) => Promise<ModSyncResult>,
  channel: { error(msg: string): void; info(msg: string): void },
): ModSyncTrigger {
  const failures = reportSyncFailures('mod sync', 'modlist.txt is not synced', (line) => channel.error(line));
  const subscription = instance.subscribe((value) => {
    void (async () => {
      const outcome = await failures.run(() => sync(value.activeProfile, value.modFolders));
      if (outcome === undefined) return;
      if (outcome.added.length > 0) {
        channel.info(`[modmanager] mod sync added ${outcome.added.length} modlist.txt line(s) for folder(s) in mods/ with no line: ${outcome.added.join(', ')}`);
      }
      if (outcome.dropped.length > 0) {
        channel.info(`[modmanager] mod sync dropped ${outcome.dropped.length} modlist.txt line(s) whose folder is gone from mods/: ${outcome.dropped.join(', ')}`);
      }
    })();
  });
  return {
    message: () => failures.message(),
    onMessageChanged: (listener) => failures.onMessageChanged(listener),
    dispose: () => { subscription.dispose(); },
  };
}

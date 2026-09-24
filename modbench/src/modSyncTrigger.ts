import type * as vscode from 'vscode';
import type { Instance } from './instanceLoader/instance';
import type { ModSyncResult } from './modlist/modlist';
import { reportSyncFailures } from './syncFailureReport';

export interface ModSyncTrigger extends vscode.Disposable {
  /** The Mods view's message line for a failed run, until a run lands. */
  message(): string | undefined;
}

// Termination: the write re-enters here, since the Instance watches modlist.txt. The next value
// agrees with mods/, so the command writes nothing, which stops the loop.
export function registerModSync(
  instance: Pick<Instance, 'subscribe'>,
  sync: (profile: string, modFolders: readonly string[] | undefined) => Promise<ModSyncResult>,
  channel: { error(msg: string): void; info(msg: string): void },
  messageChanged: () => void,
): ModSyncTrigger {
  const failures = reportSyncFailures('mod sync', 'modlist.txt is not synced', (line) => channel.error(line), messageChanged);
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
  return { message: () => failures.message(), dispose: () => { subscription.dispose(); } };
}

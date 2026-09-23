import type * as vscode from 'vscode';
import type { Instance } from './instanceLoader/instance';
import type { ModSyncResult } from './modlist/modlist';
import { errorMessage } from './ports/errorMessage';

// Termination: the write re-enters here, since the Instance watches modlist.txt. The next value
// agrees with mods/, so the command writes nothing, which stops the loop.
export function registerModSync(
  instance: Pick<Instance, 'subscribe'>,
  sync: (profile: string, modFolders: readonly string[] | undefined) => Promise<ModSyncResult>,
  channel: { error(msg: string): void; info(msg: string): void },
): vscode.Disposable {
  return instance.subscribe((value) => {
    void (async () => {
      try {
        const outcome = await sync(value.activeProfile, value.modFolders);
        if (!outcome.applied) {
          channel.error(`[modmanager] mod sync failed: ${outcome.refusal}`);
          return;
        }
        if (outcome.added.length > 0) {
          channel.info(`[modmanager] mod sync added ${outcome.added.length} modlist.txt line(s) for folder(s) in mods/ with no line: ${outcome.added.join(', ')}`);
        }
        if (outcome.dropped.length > 0) {
          channel.info(`[modmanager] mod sync dropped ${outcome.dropped.length} modlist.txt line(s) whose folder is gone from mods/: ${outcome.dropped.join(', ')}`);
        }
      } catch (err) {
        channel.error(`[modmanager] mod sync failed: ${errorMessage(err)}`);
      }
    })();
  });
}

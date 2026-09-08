import type * as vscode from 'vscode';
import { createModsWatcher } from './modsWatcher';

/** A `mods/<name>/` folder can appear or vanish outside Modbench at any time, and this watcher
 *  is the only thing that reconciles modlist.txt with it, Modbench's own installs included. */
export function registerModsReconcile(
  instanceRoot: string,
  reconcile: () => Promise<{ applied: true; added: string[]; pruned: string[] } | { applied: false; refusal: string }>,
  invalidate: () => void,
  channel: { error(msg: string): void },
): vscode.Disposable {
  return createModsWatcher(instanceRoot, () => {
    void (async () => {
      try {
        const outcome = await reconcile();
        if (!outcome.applied) {
          channel.error(`[modmanager] reconciling mods/ with modlist.txt failed: ${outcome.refusal}`);
          return;
        }
        if (outcome.added.length + outcome.pruned.length > 0) invalidate();
      } catch (err) {
        channel.error(`[modmanager] reconciling mods/ with modlist.txt failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  });
}

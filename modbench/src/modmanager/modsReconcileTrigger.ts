import type * as vscode from 'vscode';
import type { Instance } from './instance';

export type ModsReconcileOutcome =
  | { applied: true; added: string[]; pruned: string[] }
  | { applied: false; refusal: string };

// Termination: a write re-enters through this subscription, since the Instance watches mods/
// and its value runs the reconcile. The next run finds disk and modlist.txt already agreeing
// and writes nothing, which is what stops the loop.
export function registerModsReconcile(
  instance: Pick<Instance, 'subscribe'>,
  reconcile: (profile: string) => Promise<ModsReconcileOutcome>,
  invalidate: () => void,
  channel: { error(msg: string): void },
): vscode.Disposable {
  return instance.subscribe((value) => {
    void (async () => {
      try {
        const outcome = await reconcile(value.activeProfile);
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

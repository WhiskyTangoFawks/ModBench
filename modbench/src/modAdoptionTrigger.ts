import type * as vscode from 'vscode';
import type { Instance } from './instance/instance';

export type ModAdoptionOutcome =
  | { applied: true; added: string[] }
  | { applied: false; refusal: string };

// Termination: the write re-enters here, since the Instance watches modlist.txt. The next
// value's unlisted folders exclude what was adopted, so the command is handed nothing and
// writes nothing, which stops the loop.
export function registerModAdoption(
  instance: Pick<Instance, 'subscribe'>,
  adopt: (profile: string, unlistedFolders: readonly string[]) => Promise<ModAdoptionOutcome>,
  invalidate: () => void,
  channel: { error(msg: string): void },
): vscode.Disposable {
  return instance.subscribe((value) => {
    void (async () => {
      try {
        const outcome = await adopt(value.activeProfile, value.unlistedFolders);
        if (!outcome.applied) {
          channel.error(`[modmanager] adopting the unlisted mods/ folders failed: ${outcome.refusal}`);
          return;
        }
        if (outcome.added.length > 0) invalidate();
      } catch (err) {
        channel.error(`[modmanager] adopting the unlisted mods/ folders failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  });
}

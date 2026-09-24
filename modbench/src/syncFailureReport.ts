import { errorMessage } from './ports/errorMessage';

type SyncOutcome = { applied: true } | { applied: false; refusal: string };

export interface SyncFailureReport {
  /** The view's message line for the failure standing now, or undefined. */
  message(): string | undefined;
  /** Runs the command once. Its landed outcome is returned even when a later run overtook it,
   *  since what it wrote stands; only the latest run decides the failure shown. */
  run<T extends SyncOutcome>(sync: () => Promise<T>): Promise<Extract<T, { applied: true }> | undefined>;
}

/** update-load-order-file, Refusals: a system command reports a failure once when it begins, and
 *  again only when its reason changes, in the Output and its view's message line. The message
 *  line clears when the command next lands. */
export function reportSyncFailures(
  command: string, unsynced: string, log: (line: string) => void, messageChanged: () => void,
): SyncFailureReport {
  let reason: string | undefined;
  let latest = 0;
  const settle = (next: string | undefined): void => {
    if (next === reason) return;
    reason = next;
    if (next !== undefined) log(`[modmanager] ${command} failed: ${next}`);
    messageChanged();
  };
  const landed = <T extends SyncOutcome>(outcome: T): outcome is Extract<T, { applied: true }> => outcome.applied;
  return {
    message: () => (reason === undefined ? undefined : `${unsynced}: ${reason}.`),
    async run(sync) {
      const mine = ++latest;
      let outcome;
      try {
        outcome = await sync();
      } catch (err) {
        outcome = { applied: false as const, refusal: errorMessage(err) };
      }
      if (mine === latest) settle(outcome.applied ? undefined : outcome.refusal);
      return landed(outcome) ? outcome : undefined;
    },
  };
}

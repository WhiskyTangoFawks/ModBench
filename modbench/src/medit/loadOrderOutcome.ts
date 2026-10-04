import type { LoadOrderOutcome } from '../client';

/** What a put's own answer says apart from the reconcile it started: a send that failed.
 *  `abandoned` says nothing: a superseded or closed send owns no view. */
export function reportPutOutcome(result: LoadOrderOutcome, deps: { error: (msg: string) => void }): void {
  if (result.outcome === 'failed') deps.error(result.message);
}

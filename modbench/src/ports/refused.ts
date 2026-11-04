/** What a gesture or command answers when it refused and wrote nothing, so the gesture ends without the refresh that shows a write.
 *  An `applied: false` without `wroteNothing` may follow a write, and is refreshed. */
export interface Refused {
  readonly applied: false;
  readonly refusal: string;
  readonly detail?: string;
  readonly wroteNothing: true;
}

export const refusedAnswer = (refusal: string, detail?: string): Refused => ({ applied: false, refusal, ...(detail === undefined ? {} : { detail }), wroteNothing: true });

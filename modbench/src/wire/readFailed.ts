type ReadFailedKind = 'refused' | 'no-answer' | 'timed-out' | 'unreachable' | 'unreadable' | 'local';

/** A read that did not land, as data (ADR-0019). `refusal` is mEdit's own sentence, on `refused`;
 *  `cause` is this side's, on `unreadable` and `local`. Neither carries the transport's verb, path or status. */
export interface ReadFailed {
  readonly failed: ReadFailedKind;
  readonly refusal?: string;
  readonly cause?: string;
}

export const localFailure = (cause: string): ReadFailed => ({ failed: 'local', cause });

export function isReadFailed(answer: unknown): answer is ReadFailed {
  if (typeof answer !== 'object' || answer === null) return false;
  const { failed } = answer as { failed?: unknown };
  return failed === 'refused' || failed === 'no-answer' || failed === 'timed-out' || failed === 'unreachable'
    || failed === 'unreadable' || failed === 'local';
}

/** What a surface says of a failed read: mEdit's sentence when it gave one, else the kind in the
 *  front end's words. */
export function failureReason(failure: ReadFailed): string {
  switch (failure.failed) {
    case 'refused': return failure.refusal ?? 'mEdit refused.';
    case 'no-answer': return 'mEdit gave no answer.';
    case 'timed-out': return 'mEdit did not answer in time.';
    case 'unreachable': return 'mEdit could not be reached.';
    case 'unreadable': return failure.cause ?? 'mEdit answered in a form that cannot be read.';
    case 'local': return failure.cause ?? 'The read failed.';
  }
}

/** For a surface that already reports a thrown reason, as the Plugins tree's error row does: the
 *  answer, or an Error whose message is the failure in the front end's words. */
export function answerOf<A>(answer: A | ReadFailed): A {
  if (isReadFailed(answer)) throw new Error(failureReason(answer));
  return answer;
}

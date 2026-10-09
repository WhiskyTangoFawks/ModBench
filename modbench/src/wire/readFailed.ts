export type ReadFailedKind = 'refused' | 'no-answer' | 'timed-out' | 'unreachable';

/** A read that did not land, as data (ADR-0019). `refusal` is mEdit's own sentence, on `refused` alone;
 *  the transport's verb, path and status are not in it. */
export interface ReadFailed {
  readonly failed: ReadFailedKind;
  readonly refusal?: string;
}

export function isReadFailed(answer: unknown): answer is ReadFailed {
  if (typeof answer !== 'object' || answer === null) return false;
  const { failed } = answer as { failed?: unknown };
  return failed === 'refused' || failed === 'no-answer' || failed === 'timed-out' || failed === 'unreachable';
}

/** What a surface says of a failed read: mEdit's sentence when it gave one, else the kind in the
 *  front end's words. */
export function failureReason(failure: ReadFailed): string {
  switch (failure.failed) {
    case 'refused': return failure.refusal ?? 'mEdit refused.';
    case 'no-answer': return 'mEdit gave no answer.';
    case 'timed-out': return 'mEdit did not answer in time.';
    case 'unreachable': return 'mEdit could not be reached.';
  }
}

/** For a surface that already reports a thrown reason, as the Plugins tree's error row does: the
 *  answer, or an Error whose message is the failure in the front end's words. */
export function answerOf<A>(answer: A | ReadFailed): A {
  if (isReadFailed(answer)) throw new Error(failureReason(answer));
  return answer;
}

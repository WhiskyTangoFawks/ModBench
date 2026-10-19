const IN_FRONT_END_WORDS = {
  refused: 'mEdit refused.',
  'no-load-order': 'mEdit holds no load order.',
  'no-answer': 'mEdit gave no answer.',
  'timed-out': 'mEdit did not answer in time.',
  unreachable: 'mEdit could not be reached.',
  unreadable: 'mEdit answered in a form that cannot be read.',
  local: 'The read failed.',
};

type ReadFailedKind = keyof typeof IN_FRONT_END_WORDS;

/** A read that did not land, as data (ADR-0019). `refusal` is mEdit's own sentence, on `refused` and
 *  `no-load-order`, a read not yet answerable; `cause` is this side's. None carries the transport's verb, path or status. */
export interface ReadFailed {
  readonly failed: ReadFailedKind;
  readonly refusal?: string;
  readonly cause?: string;
}

export const localFailure = (cause: string): ReadFailed => ({ failed: 'local', cause });

export function isReadFailed(answer: unknown): answer is ReadFailed {
  if (typeof answer !== 'object' || answer === null) return false;
  const { failed } = answer as { failed?: unknown };
  return typeof failed === 'string' && Object.hasOwn(IN_FRONT_END_WORDS, failed);
}

/** What a surface says of a failed read: the sentence it carries when it has one, else the kind in the
 *  front end's words. */
export const failureReason = (failure: ReadFailed): string =>
  failure.refusal ?? failure.cause ?? IN_FRONT_END_WORDS[failure.failed];

/** For a surface that already reports a thrown reason, as the Plugins tree's error row does: the
 *  answer, or an Error whose message is the failure in the front end's words. */
export function answerOf<A>(answer: A | ReadFailed): A {
  if (isReadFailed(answer)) throw new Error(failureReason(answer));
  return answer;
}

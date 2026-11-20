/** Reasons in one line, each ending where the next begins: a full stop before "; " would read ".;". */
export const joinedReasons = (reasons: readonly string[]): string =>
  reasons.map((reason, i) => (i < reasons.length - 1 ? reason.replace(/\.$/, '') : reason)).join('; ');

/** common.md, States, story 6: the message line naming why the rows are the last good read; nothing when none is. */
export const lastGoodReadMessage = (reasons: readonly string[]): string | undefined =>
  reasons.length === 0 ? undefined : `Showing the last good read: ${joinedReasons(reasons)}`;

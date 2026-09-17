/** A refusal becomes a throw, so one catch-and-report path serves a rejected promise and an
 *  `{ applied: false }` result alike. */
export function applyOrThrow<T extends { applied: true } | { applied: false; refusal: string }>(
  outcome: T,
): asserts outcome is Extract<T, { applied: true }> {
  if (!outcome.applied) throw new Error(outcome.refusal);
}

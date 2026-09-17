// `noUncheckedIndexedAccess` cannot see an index the surrounding code has already bounded (a
// prior length/find check, a regex group a pattern always captures). Every such site reads the
// value through here, the one throw of that shape.

/** `value`, or throws an invariant violation naming `description` when it is `undefined` —
 *  for a lookup the caller has already bounded, so `undefined` here means the invariant broke,
 *  never a real case to handle. */
export function present<T>(value: T | undefined, description: string): T {
  if (value === undefined) throw new Error(`Invariant violated: expected ${description}`);
  return value;
}

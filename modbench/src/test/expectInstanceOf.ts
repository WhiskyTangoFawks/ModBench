// A mocked tree provider answers with the node union it's typed to; narrowing one row to its
// concrete subtype goes through `instanceof` here, not an `as` the checker can't verify.

/** `value`, narrowed to `T` by `instanceof ctor`, or throws — for a single row a test already
 *  knows the concrete type of (often via a prior `toBeInstanceOf` assertion on the same value). */
export function expectInstanceOf<T>(value: unknown, ctor: new (...args: never[]) => T): T {
  if (value instanceof ctor) return value;
  throw new Error(`Expected instance of ${ctor.name}, got ${String(value)}`);
}

/** {@link expectInstanceOf}, but `undefined` passes through instead of throwing — for an optional
 *  field a test only narrows when present. */
export function expectInstanceOfOrUndefined<T>(
  value: unknown, ctor: new (...args: never[]) => T,
): T | undefined {
  return value === undefined ? undefined : expectInstanceOf(value, ctor);
}

/** {@link expectInstanceOf} applied element-wise — for a node union array a test already knows is
 *  homogeneous. */
export function expectInstancesOf<T>(values: readonly unknown[], ctor: new (...args: never[]) => T): T[] {
  return values.map((v) => expectInstanceOf(v, ctor));
}

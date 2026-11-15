const sameInputs = (a: readonly unknown[], b: readonly unknown[]): boolean => a.length === b.length && a.every((input, at) => Object.is(input, b[at]));

/** `build`, answering what it built last while each input is the one it built from: an object by identity, a primitive by
 *  value. */
export function lastBuilt<A extends readonly unknown[], R>(build: (...inputs: A) => R): (...inputs: A) => R {
  let last: { readonly inputs: A; readonly built: R } | undefined;
  return (...inputs) => {
    if (last !== undefined && sameInputs(last.inputs, inputs)) return last.built;
    const built = build(...inputs);
    last = { inputs, built };
    return built;
  };
}

/** Takes what a destructuring that names each part of a fact left, so a field added to the fact's type fails to compile. */
export const noneLeft = (rest: Readonly<Record<string, never>>): [] => {
  void rest;
  return [];
};

/** `fact`, or the one handed last while `parts`, what it was read as, are each the same: for a fact no kept read answers. */
export function lastHanded<T>(): (fact: T, parts: readonly unknown[]) => T {
  let last: { readonly parts: readonly unknown[]; readonly fact: T } | undefined;
  return (fact, parts) => {
    if (last !== undefined && sameInputs(last.parts, parts)) return last.fact;
    last = { parts, fact };
    return fact;
  };
}

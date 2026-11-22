/** The keys whose entries are other objects in the two maps, or that one map alone holds. */
export const changedKeys = <V>(now: ReadonlyMap<string, V>, before: ReadonlyMap<string, V>): string[] =>
  (now === before ? [] : [...new Set([...now.keys(), ...before.keys()])].filter((key) => now.get(key) !== before.get(key)));

export const sameInputs = (a: readonly unknown[], b: readonly unknown[]): boolean => a.length === b.length && a.every((input, at) => Object.is(input, b[at]));

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

// The parts each fact was read as, so a fact compares with a landed one without either taken apart again.
const partsOf = new WeakMap<object, readonly unknown[]>();

/** `fact`, noted as read as `parts`. */
export function readAs<T extends object | undefined>(fact: T, parts: readonly unknown[]): T {
  if (fact !== undefined) partsOf.set(fact, parts);
  return fact;
}

/** `fact`, or `landed`, what the caller's value last landed from, while the two were read as the same parts. */
export function asLanded<T extends object | undefined>(fact: T, landed: T | undefined): T {
  if (fact === undefined || landed === undefined) return fact;
  const [now, before] = [partsOf.get(fact), partsOf.get(landed)];
  return now !== undefined && before !== undefined && sameInputs(now, before) ? landed : fact;
}

/** The calls made to the functions of every module `countingCalls` wraps. */
export const fileSystemCalls = { count: 0 };

// A class keeps its constructor, and a wrapped function its own properties, such as `realpath.native`.
const counting = (module: object, name: string, member: unknown): unknown => (typeof member === 'function' && /^[a-z]/.test(name)
  ? Object.assign((...args: unknown[]): unknown => { fileSystemCalls.count++; return Reflect.apply(member, module, args); }, member)
  : member);

/** `module`, each function counting its calls in `fileSystemCalls`. A leaf, so a `vi.mock` factory can import it. */
export const countingCalls = (module: object): Record<string, unknown> =>
  Object.fromEntries(Object.entries(module).map(([name, member]: [string, unknown]) => [name, counting(module, name, member)]));

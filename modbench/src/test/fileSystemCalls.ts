/** The calls made to the functions of every module `countingCalls` wraps. */
export const fileSystemCalls = { count: 0 };

/** `module`, each function counting its calls in `fileSystemCalls`. A leaf, so a `vi.mock` factory can import it. */
export const countingCalls = (module: object): Record<string, unknown> => Object.fromEntries(Object.entries(module).map(([name, member]: [string, unknown]) => [
  name,
  typeof member === 'function' ? (...args: unknown[]): unknown => { fileSystemCalls.count++; return Reflect.apply(member, module, args); } : member,
]));

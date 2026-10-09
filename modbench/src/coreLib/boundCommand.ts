/** A core command's arguments after the one the root binds: what a gesture passes. */
export type TailOf<F extends (bound: never, ...args: never[]) => unknown> =
  F extends (bound: never, ...args: infer A) => unknown ? A : never;

/** ADR-0019 invariant 3 surfacing: one modal question, answered by the pressed button's label or
 *  `undefined` for the native cancel. Injected, so the asking module is testable without a VS
 *  Code host. */
export type AskQuestion = (
  message: string, options: { modal: true; detail?: string }, ...buttons: string[]
) => PromiseLike<string | undefined>;

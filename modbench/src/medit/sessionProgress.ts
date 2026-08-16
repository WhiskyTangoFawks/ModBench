import type { SessionLoadProgress } from './SessionController';

/** #307 / ADR-0035: what the Plugins view says about itself while a load is running — the text
 *  behind `TreeView.message`, and the whole of AC3.
 *
 *  The statement exists because **an absent conflict badge is indistinguishable from "no
 *  conflict"**. If browsing opens at second five and the winner sweep lands at second ninety,
 *  then for eighty-five seconds an unmarked record silently claims to be conflict-free when
 *  nothing has looked. Saying so is what makes the incomplete session honest rather than merely
 *  early.
 *
 *  Gated on `conflictsComputed` and nothing else — deliberately not on "is a load running".
 *  The sweep is whole-set, so ADR-0035's live mutations (reorder, enable, disable) will leave a
 *  finished session with stale winners, and this message has to be reachable in that state too
 *  (`SessionStatus.cs` makes the field's separateness from `State` its whole reason to exist).
 *
 *  Returns `undefined` for "nothing to say" — the value `TreeView.message` itself takes to clear.
 *  A pure function of the status so it is unit-testable without a VS Code harness; the assignment
 *  to the view is a one-line glue in `extension.ts`. */
export function sessionProgressMessage(status: SessionLoadProgress): string | undefined {
  if (status.conflictsComputed) return undefined;
  // Before the backend publishes the session, status is SessionStatus.None — no total yet. "0 of
  // 0 plugins indexed" reads as a stalled load rather than one still opening the load order, so
  // the count waits until there is one to state.
  const counted = status.totalPlugins > 0
    ? `Loading session — ${status.indexedPlugins.length} of ${status.totalPlugins} plugins indexed.`
    : 'Loading session…';
  return `${counted} Conflict information is not yet computed.`;
}

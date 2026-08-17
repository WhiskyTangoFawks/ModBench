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
  return `${countedPhase(status)} Conflict information is not yet computed.`;
}

/** The count half of {@link sessionProgressMessage} — split out only to give each phase its own
 *  early return rather than a nested ternary. */
function countedPhase(status: SessionLoadProgress): string {
  // Before the backend publishes the session, status is SessionStatus.None — no total yet. "0 of
  // 0 plugins indexed" reads as a stalled load rather than one still opening the load order, so
  // the count waits until there is one to state.
  if (status.totalPlugins === 0) return 'Loading session…';
  // #342: `IndexProgressively` opens and indexes one plugin at a time, so an empty
  // `indexedPlugins` here is honest — the load order's first plugin (often a large base-game
  // master) can take a real while to open and index before anything lands. But a bare "0 of 612"
  // reads exactly like a stalled load, indistinguishable from one that truly is stuck, so this
  // phase names the work in progress instead of leaving a static-looking count to speak for it.
  // The count itself stays — dropping it would trade "looks stuck" for "how big is this even".
  if (status.indexedPlugins.length === 0) {
    return `Loading session — opening and indexing the first plugin(s) (0 of ${status.totalPlugins} indexed so far)…`;
  }
  return `Loading session — ${status.indexedPlugins.length} of ${status.totalPlugins} plugins indexed.`;
}

/** #308 / ADR-0035: the record editor's own half of "an absent conflict badge must never be
 *  mistakable for 'no conflict'" (#307 built the tree's). Unlike the tree, this surface *does*
 *  render conflict colouring today — an unmarked cell here doesn't just omit a badge, it actively
 *  paints a verdict — so the statement has to name both facts: the comparison itself is
 *  incomplete, and the colouring rendered from it is not final because of that. One without the
 *  other misses the point.
 *
 *  Gated on `conflictsComputed` alone, same reasoning as `sessionProgressMessage` — the sweep is
 *  whole-set, so ADR-0035's live mutations (reorder, enable, disable, #97) will leave a *Ready*
 *  session with stale winners, and this statement has to be reachable in that state too.
 *
 *  Returns `undefined` for "nothing to say", mirroring `sessionProgressMessage` — the caller
 *  renders nothing rather than an empty banner. No plugin count here (unlike the tree's message):
 *  this is one record, not a whole load order, so "N of M" has nothing useful to name. */
export function recordPanelIncompleteMessage(conflictsComputed: boolean): string | undefined {
  if (conflictsComputed) return undefined;
  return 'This record\'s comparison is not yet complete: conflict information has not been '
    + 'computed for every plugin, so the colouring here is not final.';
}

/** #307: one poll tick of a running load, translated into what the tree and the view should do
 *  about it — chevrons for what is indexed, decorations for what has failed, and the statement of
 *  what is not yet known.
 *
 *  Lives here rather than in `extension.ts` so it is unit-testable without a VS Code harness: it
 *  knows *when* a tick is worth applying, which is real logic, while `applySession` — the actual
 *  hand-off to the tree, and the only part that needs VS Code types — stays a caller's closure.
 *
 *  Mid-load, a tick carries only the indexed set and the failures. Read-only state and master
 *  issues are whole-session derivations a partial session cannot answer (the backend suppresses
 *  master issues outright while loading — `RecordQueryService.GetPlugins` gates them on
 *  `SessionState.Ready`), so they land in one piece when the load completes. **A tick is never
 *  the last word**: the poll stops before `loadExplicitSession` returns, so the completed load's
 *  own hand-off always follows the final tick — otherwise those two decorations would silently
 *  vanish from a fully loaded tree. */
export function makeLoadProgressHandler(deps: {
  say: (message: string | undefined) => void;
  applySession: (indexedPlugins: string[], failures: { name: string; reason: string }[]) => void;
}): (status: SessionLoadProgress) => void {
  let lastLanded = '';
  return (status) => {
    // Deliberately not behind the guard below: the statement's plugin count moves even on ticks
    // that land nothing worth a re-render, and a stale count reads as a stalled load.
    deps.say(sessionProgressMessage(status));
    // Apply only when something actually landed. Applying re-renders the whole tree, and
    // `PluginTreeProvider.getPluginChildren` is uncached, so re-applying an unchanged tick every
    // poll would re-fetch record types for every expanded row — a request storm on a deep tree,
    // for no visible change. Failures count as landing too (AC6): a plugin that failed to index
    // is never added to the indexed set, so counting only plugins would leave its row
    // undecorated until the next plugin happened to land.
    const landed = `${status.indexedPlugins.length}:${status.failures.length}`;
    if (landed === lastLanded) return;
    lastLanded = landed;
    deps.applySession(status.indexedPlugins, status.failures);
  };
}

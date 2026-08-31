import type { LoadOrderProgress } from './EditingController';

/** ADR-0035: the record editor's own statement that a comparison is not yet final — an
 *  unmarked cell here doesn't just omit a badge, it actively paints a verdict, so the statement
 *  has to name both facts: the comparison itself is incomplete, and the colouring rendered from
 *  it is not final because of that. One without the other misses the point.
 *
 *  Gated on `conflictsComputed` alone — the sweep is whole-set, so a reconcile that changes
 *  anything (ADR-0044) leaves a *Ready* load order with stale winners until it re-runs, and this
 *  statement has to be reachable in that state too.
 *
 *  Returns `undefined` for "nothing to say" — the caller renders nothing rather than an empty
 *  banner. No plugin count here: this is one record, not a whole load order, so "N of M" has
 *  nothing useful to name. */
export function recordPanelIncompleteMessage(conflictsComputed: boolean): string | undefined {
  if (conflictsComputed) return undefined;
  return 'This record\'s comparison is not yet complete: conflict information has not been '
    + 'computed for every plugin, so the colouring here is not final.';
}

/** One poll tick of a running reconcile, translated into what the tree should do about it —
 *  chevrons for what is indexed, decorations for what has failed.
 *
 *  Lives here rather than in `extension.ts` so it is unit-testable without a VS Code harness: it
 *  knows *when* a tick is worth applying, which is real logic, while `applyLoadOrder` — the actual
 *  hand-off to the tree, and the only part that needs VS Code types — stays a caller's closure.
 *
 *  Mid-reconcile, a tick carries only the indexed set and the failures. Read-only state and master
 *  issues are whole-load-order derivations a partial one cannot answer (the backend suppresses
 *  master issues outright while reconciling — `RecordQueryService.GetPlugins` gates them on
 *  `LoadOrderState.Ready`), so they land in one piece when the reconcile completes. **A tick is
 *  never the last word**: the poll stops before `putLoadOrder` returns, so the completed
 *  reconcile's own hand-off always follows the final tick — otherwise those two decorations would
 *  silently vanish from a fully reconciled tree. */
export function makeReconcileProgressHandler(deps: {
  applyLoadOrder: (indexedPlugins: string[], failures: { name: string; reason: string }[]) => void;
}): (status: LoadOrderProgress) => void {
  let lastLanded = '';
  return (status) => {
    // Applying only when something actually landed. Applying re-renders the whole tree, and
    // `PluginTreeProvider.getPluginChildren` is uncached, so re-applying an unchanged tick every
    // poll would re-fetch record types for every expanded row — a request storm on a deep tree,
    // for no visible change. Failures count as landing too: a plugin that failed to index
    // is never added to the indexed set, so counting only plugins would leave its row
    // undecorated until the next plugin happened to land.
    const landed = `${status.indexedPlugins.length}:${status.failures.length}`;
    if (landed === lastLanded) return;
    lastLanded = landed;
    deps.applyLoadOrder(status.indexedPlugins, status.failures);
  };
}

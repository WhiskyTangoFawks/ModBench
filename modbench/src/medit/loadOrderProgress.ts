import type { LoadOrderProgress } from './EditingController';

/** An unmarked cell does not merely omit a badge, it paints a verdict. Gated on
 *  `conflictsComputed` alone: the sweep is whole-set, so a changed load order leaves stale
 *  winners until it re-runs (ADR-0044). */
export function recordPanelIncompleteMessage(conflictsComputed: boolean): string | undefined {
  if (conflictsComputed) return undefined;
  return 'This record\'s comparison is not yet complete: conflict information has not been '
    + 'computed for every plugin, so the colouring here is not final.';
}

/** A tick is never the last word: the poll stops before `putLoadOrder` returns, so the completed
 *  reconcile's hand-off always follows the final tick — otherwise read-only state and master
 *  issues would vanish from a fully reconciled tree. */
export function makeReconcileProgressHandler(deps: {
  applyLoadOrder: (indexedPlugins: string[], failures: { name: string; reason: string }[]) => void;
}): (status: LoadOrderProgress) => void {
  let lastLanded = '';
  return (status) => {
    // Applying re-renders the whole tree and `getPluginChildren` is uncached, so re-applying an
    // unchanged tick every poll would re-fetch record types for every expanded row. Failures
    // count as landing: a failed plugin never joins the indexed set.
    const landed = `${status.indexedPlugins.length}:${status.failures.length}`;
    if (landed === lastLanded) return;
    lastLanded = landed;
    deps.applyLoadOrder(status.indexedPlugins, status.failures);
  };
}

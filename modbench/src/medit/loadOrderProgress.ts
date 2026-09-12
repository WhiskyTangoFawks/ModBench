import type { LoadOrderProgress, PluginLoadFailure } from './client';

/** A tick is never the last word: the subscription stops before `putLoadOrder` returns, so the
 *  completed reconcile's hand-off always follows the final tick — otherwise read-only state and
 *  master issues would vanish from a fully reconciled tree. */
export function makeReconcileProgressHandler(deps: {
  applyLoadOrder: (indexedPlugins: string[], failures: PluginLoadFailure[]) => void;
}): (status: LoadOrderProgress) => void {
  let lastLanded = '';
  return (status) => {
    // Applying re-renders the whole tree and `getPluginChildren` is uncached, so re-applying an
    // unchanged tick every notification would re-fetch record types for every expanded row.
    // Failures count as landing: a failed plugin never joins the indexed set.
    const landed = `${status.indexedPlugins.length}:${status.failures.length}`;
    if (landed === lastLanded) return;
    lastLanded = landed;
    deps.applyLoadOrder(status.indexedPlugins, status.failures);
  };
}

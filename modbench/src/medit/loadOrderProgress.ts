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

/** The Index's own known refusal (ADR-0009 point 5), discovered mid-reconcile — the put's own
 *  outcome reports applied regardless (ADR-0013), so a tick carrying it is the only place
 *  "another window has this instance open" is ever seen. */
export function reportIndexHeldElsewhere(
  status: LoadOrderProgress, deps: { error: (msg: string) => void },
): void {
  if (status.heldElsewhereMessage) deps.error(`mEdit: Failed to send the load order — ${status.heldElsewhereMessage}`);
}

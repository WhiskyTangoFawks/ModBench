import type { PluginAddress, PluginLoadFailure } from '../client';

/** A tick is never the last word: the narrator hands Ready to the views after the final tick —
 *  otherwise read-only state and sorting statuses would vanish from a fully reconciled tree. */
export function makeReconcileProgressHandler(deps: {
  applyLoadOrder: (indexedPlugins: readonly PluginAddress[], failures: readonly PluginLoadFailure[]) => void;
}): (heard: { indexed: readonly PluginAddress[]; failures: readonly PluginLoadFailure[] }) => void {
  let lastLanded = '';
  return ({ indexed, failures }) => {
    // Applying re-renders the whole tree and `getPluginChildren` is uncached, so re-applying an
    // unchanged tick every notification would re-fetch record types for every expanded row.
    // Failures count as landing: a failed plugin never joins the indexed set.
    const landed = `${indexed.length}:${failures.length}`;
    if (landed === lastLanded) return;
    lastLanded = landed;
    deps.applyLoadOrder(indexed, failures);
  };
}

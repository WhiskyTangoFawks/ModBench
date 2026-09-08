/** ADR-0046: the Toolbox's Refresh — one need, not four. Rebuild, resend, then re-read: a
 *  rebuild that never lands must send no load order and re-read nothing. */
export interface RefreshAllDeps {
  /** Resolves false on a reported failure (423 held elsewhere, backend down); the caller must
   *  send no load order and re-read nothing in that case. */
  rebuildIndex: () => Promise<boolean>;
  sendLoadOrder: () => Promise<unknown>;
  invalidateMods: () => void;
  invalidatePlugins: () => void;
  invalidateDownloads: () => void;
  updateProfileDescription: () => Promise<void>;
}

export function makeRefreshAll(deps: RefreshAllDeps): () => Promise<void> {
  return async () => {
    if (!(await deps.rebuildIndex())) return;
    await deps.sendLoadOrder();
    deps.invalidateMods();
    deps.invalidatePlugins();
    deps.invalidateDownloads();
    await deps.updateProfileDescription();
  };
}

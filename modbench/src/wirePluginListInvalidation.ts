/** #653: `wireLoadOrderWatchers` (extension.ts) feeds the mods folder, every profile's
 *  modlist.txt, and every profile's plugins.txt watchers exclusively into `sync.request()` —
 *  Editing's own reconcile. Nothing tells the Plugins tab's own row provider to re-read, so an
 *  external plugins.txt edit (MO2, another tool, the user) leaves it stale until a manual Refresh.
 *
 *  This composes a second consumer onto those same three already-firing signals — never a new
 *  watcher, never a replacement of the first consumer — so a naive rewrite that swaps one
 *  listener for the other (silently dropping Editing's own reconcile, #621's fan-out) is exactly
 *  the bug this shape exists to make impossible to write by accident: `watcherEvents` in, the
 *  same three names back out, each now doing both jobs.
 *
 *  Deliberately unaware of what `pluginListProvider` is — a bare `{ invalidate }` shape, not the
 *  real `PluginListProvider` type — so this file never imports Mod Management's vocabulary, the
 *  same reasoning `loadOrderReconcile.ts` documents for staying opaque to both bounded contexts
 *  (`src/test/contextBoundary.test.ts`). Pulled out of `extension.ts`, which has no unit-test
 *  seam of its own, purely so this one wiring decision gets a real test — same shape as
 *  `createRunScheduler`/`createReconcileSequencer` in `loadOrderReconcile.ts`. */
export interface WatcherEvents {
  onModsChange: () => void;
  onModlistChange: () => void;
  onPluginsChange: () => void;
}

export function wirePluginListInvalidation(
  watcherEvents: WatcherEvents,
  pluginListProvider: { invalidate: () => void },
): WatcherEvents {
  return {
    onModsChange: () => { watcherEvents.onModsChange(); pluginListProvider.invalidate(); },
    onModlistChange: () => { watcherEvents.onModlistChange(); pluginListProvider.invalidate(); },
    onPluginsChange: () => { watcherEvents.onPluginsChange(); pluginListProvider.invalidate(); },
  };
}

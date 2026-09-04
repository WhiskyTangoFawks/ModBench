/** Composes a second consumer onto the watcher signals Editing's reconcile already uses — never a
 *  replacement, which would silently drop that reconcile. The bare `{ invalidate }` shape keeps
 *  this file free of either bounded context's vocabulary. */
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

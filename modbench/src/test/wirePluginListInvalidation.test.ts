import { describe, it, expect, vi } from 'vitest';
import { wirePluginListInvalidation, type WatcherEvents } from '../wirePluginListInvalidation';

function makeWatcherEvents(): { events: WatcherEvents; onMods: () => void; onModlist: () => void; onPlugins: () => void } {
  const onMods = vi.fn();
  const onModlist = vi.fn();
  const onPlugins = vi.fn();
  return { events: { onModsChange: onMods, onModlistChange: onModlist, onPluginsChange: onPlugins }, onMods, onModlist, onPlugins };
}

describe('wirePluginListInvalidation', () => {
  // #653 AC1: an external plugins.txt change must reach the Plugins tab. This is the red test —
  // it reproduces the miss at the seam the fix lands on, before any wiring into extension.ts.
  it('invalidates the plugin list when the plugins.txt watcher signal fires', () => {
    const { events } = makeWatcherEvents();
    const invalidate = vi.fn();

    const wired = wirePluginListInvalidation(events, { invalidate });
    wired.onPluginsChange();

    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  // #653 AC2: all three watcher signals — mods folder, modlist.txt, plugins.txt — are wired the
  // same way, not just plugins.txt. AC4 (a Mods-view checkbox toggle refreshes the Plugins tab)
  // is this same modlist.txt case: `ModListProvider.setModEnabled` delegates to
  // `Mo2ModlistSource.setEnabled` (pinned by "setModEnabled delegates to the source and fires a
  // refresh", ModListProvider.test.ts), which writes modlist.txt on disk (pinned by "setEnabled
  // flips only the target prefix on disk, preserving all other bytes", Mo2ModlistSource.test.ts)
  // — the same file this watcher signal covers, so there is no second mechanism to wire, only
  // this one.
  it('invalidates the plugin list for every watcher signal, not only plugins.txt', () => {
    const { events } = makeWatcherEvents();
    const invalidate = vi.fn();

    const wired = wirePluginListInvalidation(events, { invalidate });
    wired.onModsChange();
    wired.onModlistChange();

    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  // #653 AC5 (a green-on-arrival guard): the reconcile fan-out (`sync.request()`, stood in for
  // here by the original watcherEvents callbacks) must keep firing — the invalidate call is
  // added alongside it, never in its place. The named rival this guards against: a wiring that
  // *replaces* the original consumer instead of adding a second one, which would silently drop
  // Editing's own reconcile (#621). See this file's own rival experiment, run once by hand
  // against a copy with the body swapped to call only `pluginListProvider.invalidate()` — it
  // failed this exact assertion, confirming the guard is not vacuous.
  it('never drops the original watcher callback — sync.request()\'s stand-in still fires for every signal', () => {
    const { events, onMods, onModlist, onPlugins } = makeWatcherEvents();
    const invalidate = vi.fn();

    const wired = wirePluginListInvalidation(events, { invalidate });
    wired.onModsChange();
    wired.onModlistChange();
    wired.onPluginsChange();

    expect(onMods).toHaveBeenCalledTimes(1);
    expect(onModlist).toHaveBeenCalledTimes(1);
    expect(onPlugins).toHaveBeenCalledTimes(1);
  });
});

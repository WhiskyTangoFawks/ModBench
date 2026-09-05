import { describe, it, expect, vi } from 'vitest';
import { wirePluginListInvalidation, type WatcherEvents } from '../wirePluginListInvalidation';

function makeWatcherEvents(): { events: WatcherEvents; onMods: () => void; onModlist: () => void; onPlugins: () => void } {
  const onMods = vi.fn();
  const onModlist = vi.fn();
  const onPlugins = vi.fn();
  return { events: { onModsChange: onMods, onModlistChange: onModlist, onPluginsChange: onPlugins }, onMods, onModlist, onPlugins };
}

describe('wirePluginListInvalidation', () => {
  it('invalidates the plugin list when the plugins.txt watcher signal fires', () => {
    const { events } = makeWatcherEvents();
    const invalidate = vi.fn();

    const wired = wirePluginListInvalidation(events, { invalidate });
    wired.onPluginsChange();

    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  // All three watcher signals — mods folder, modlist.txt, plugins.txt — are wired alike: a
  // Mods-view checkbox toggle is the modlist.txt case, since setModEnabled writes that file.
  it('invalidates the plugin list for every watcher signal, not only plugins.txt', () => {
    const { events } = makeWatcherEvents();
    const invalidate = vi.fn();

    const wired = wirePluginListInvalidation(events, { invalidate });
    wired.onModsChange();
    wired.onModlistChange();

    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  // The reconcile fan-out (`sync.request()`) must keep firing: the invalidate call is added
  // alongside it, never in its place. The rival — a wiring that replaces the original consumer —
  // would silently drop Editing's own reconcile.
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

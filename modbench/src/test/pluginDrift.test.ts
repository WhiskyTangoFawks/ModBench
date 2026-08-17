import { describe, it, expect, vi, beforeEach } from 'vitest';

// #279 / ADR-0035 § Live mutation. Drift is a comparison between two facts neither bounded
// context may hold together: where a plugin's records were read from (the session's), and where
// its name resolves now (Mod Management's). So it is tested here, at the composition root, in
// neither context's vocabulary — an origin is an opaque string on both sides, which is exactly
// what ADR-0036 makes it.

vi.mock('vscode', () => {
  class EventEmitter<T> {
    private handlers: ((e: T) => void)[] = [];
    event = (cb: (e: T) => void) => { this.handlers.push(cb); return { dispose: () => { /* no-op */ } }; };
    fire(e: T) { this.handlers.forEach((cb) => cb(e)); }
    dispose() { this.handlers = []; }
  }
  return { EventEmitter };
});

import { createDriftTracker, type ResolvedOrigin } from '../pluginDrift';

/** Mod Management's answer, as the tracker sees it: a case-folded name → where it resolves now. */
const currently = (entries: Record<string, ResolvedOrigin>) =>
  vi.fn(() => Promise.resolve(new Map(Object.entries(entries))));

describe('drift tracker', () => {
  let log: ReturnType<typeof vi.fn>;
  beforeEach(() => { log = vi.fn(); });

  const make = (currentOrigins: () => Promise<Map<string, ResolvedOrigin>>) =>
    createDriftTracker({ currentOrigins, log });

  it('a plugin still resolving to the origin it was loaded from has not drifted', async () => {
    const tracker = make(currently({ 'foo.esp': { origin: 'ModA', path: '/mods/A/Foo.esp' } }));
    tracker.setLoaded(new Map([['Foo.esp', 'ModA']]));

    await tracker.refresh();

    expect(tracker.driftOf('Foo.esp')).toBeUndefined();
  });

  it('a plugin now resolving to a different mod has drifted, and names both origins', async () => {
    const tracker = make(currently({ 'foo.esp': { origin: 'ModB', path: '/mods/B/Foo.esp' } }));
    tracker.setLoaded(new Map([['Foo.esp', 'ModA']]));

    await tracker.refresh();

    expect(tracker.driftOf('Foo.esp')).toEqual({
      loadedOrigin: 'ModA',
      currentOrigin: 'ModB',
      currentPath: '/mods/B/Foo.esp',
    });
  });

  // Uninstalling the only provider of a loaded plugin. The records stay browsable; there is
  // simply nothing left to re-read, which the row has to be able to say.
  it('a plugin whose name now resolves to nothing has drifted, with nothing to re-read', async () => {
    const tracker = make(currently({ 'foo.esp': null }));
    tracker.setLoaded(new Map([['Foo.esp', 'ModA']]));

    await tracker.refresh();

    expect(tracker.driftOf('Foo.esp')).toEqual({
      loadedOrigin: 'ModA',
      currentOrigin: null,
      currentPath: null,
    });
  });

  it('matches the loaded plugin to its current origin case-insensitively', async () => {
    const tracker = make(currently({ 'foo.esp': { origin: 'ModA', path: '/mods/A/Foo.esp' } }));
    tracker.setLoaded(new Map([['FOO.ESP', 'moda']]));

    await tracker.refresh();

    // Neither the filename nor the origin is authoritative about its own casing — plugins.txt and
    // mods/ both come off a case-insensitive filesystem in practice.
    expect(tracker.driftOf('foo.esp')).toBeUndefined();
  });

  // #334's rule, at this seam: an absent marker must never be produced by a failed computation.
  // "No drift" and "could not tell" look identical on a row, so the failed answer is discarded
  // rather than believed.
  it('a failed computation retains what it last knew instead of reporting no drift', async () => {
    const currentOrigins = vi.fn()
      .mockResolvedValueOnce(new Map<string, ResolvedOrigin>([['foo.esp', { origin: 'ModB', path: '/mods/B/Foo.esp' }]]))
      .mockRejectedValueOnce(new Error('mods/ walk failed'));
    const tracker = make(currentOrigins as () => Promise<Map<string, ResolvedOrigin>>);
    tracker.setLoaded(new Map([['Foo.esp', 'ModA']]));

    await tracker.refresh();
    expect(tracker.driftOf('Foo.esp')).toMatchObject({ currentOrigin: 'ModB' });

    await tracker.refresh();

    expect(tracker.driftOf('Foo.esp')).toMatchObject({ currentOrigin: 'ModB' });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('mods/ walk failed'));
  });

  it('a first computation that fails reports nothing about any row, and says so', async () => {
    const tracker = make(vi.fn().mockRejectedValue(new Error('mods/ walk failed')) as () => Promise<Map<string, ResolvedOrigin>>);
    tracker.setLoaded(new Map([['Foo.esp', 'ModA']]));

    await tracker.refresh();

    // Nothing known either way — which is the same rendering as "no drift", and the reason the
    // failure has to reach the log where a reader can find it.
    expect(tracker.driftOf('Foo.esp')).toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('mods/ walk failed'));
  });

  it('closing the session drops every drift marker without asking Mod Management anything', async () => {
    const currentOrigins = currently({ 'foo.esp': { origin: 'ModB', path: '/mods/B/Foo.esp' } });
    const tracker = make(currentOrigins);
    tracker.setLoaded(new Map([['Foo.esp', 'ModA']]));
    await tracker.refresh();
    expect(tracker.driftOf('Foo.esp')).toBeDefined();

    tracker.setLoaded(undefined);

    expect(tracker.driftOf('Foo.esp')).toBeUndefined();
    expect(currentOrigins).toHaveBeenCalledTimes(1); // no session, nothing to compare — no walk
  });

  it('asks only about the plugins the session actually holds', async () => {
    const currentOrigins = currently({});
    const tracker = make(currentOrigins);
    tracker.setLoaded(new Map([['Foo.esp', 'ModA'], ['Bar.esp', 'ModB']]));

    await tracker.refresh();

    expect(currentOrigins).toHaveBeenCalledWith(['Foo.esp', 'Bar.esp']);
  });

  it('refreshing with no session never walks the mod tree', async () => {
    const currentOrigins = currently({});
    const tracker = make(currentOrigins);

    await tracker.refresh();

    expect(currentOrigins).not.toHaveBeenCalled();
  });

  it('announces a change so the tree can re-render', async () => {
    const tracker = make(currently({ 'foo.esp': { origin: 'ModB', path: '/mods/B/Foo.esp' } }));
    const heard: unknown[] = [];
    tracker.onDidChange(() => heard.push(true));
    tracker.setLoaded(new Map([['Foo.esp', 'ModA']]));

    await tracker.refresh();

    expect(heard.length).toBeGreaterThan(0);
  });

  // A name the session holds but Mod Management never answered for is not "no drift" — it is the
  // same unknown as a failed walk, one row wide.
  it('a plugin the current-origin answer omits entirely reports nothing rather than no drift', async () => {
    const tracker = make(currently({}));
    tracker.setLoaded(new Map([['Foo.esp', 'ModA']]));

    await tracker.refresh();

    expect(tracker.driftOf('Foo.esp')).toBeUndefined();
  });
});

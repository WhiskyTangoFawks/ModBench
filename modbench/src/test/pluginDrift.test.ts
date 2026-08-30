import { describe, it, expect, vi, beforeEach } from 'vitest';

// #279 / #356 / ADR-0035 § Live mutation. Origin drift is a comparison
// between two facts neither bounded context may hold together: where a plugin's records were read
// from (the session's), and where its name resolves now (Mod Management's) — and, since #356, the
// reaction to a mismatch too: an automatic re-read, with no decoration and no user gesture. So all
// of it is tested here, at the composition root, in neither context's vocabulary — an origin is an
// opaque string on both sides, which is exactly what ADR-0036 makes it.

vi.mock('vscode', () => ({}));

import { createDriftTracker, type ResolvedOrigin } from '../pluginDrift';

/** Mod Management's answer, as the tracker sees it: a case-folded name → where it resolves now. */
const currently = (entries: Record<string, ResolvedOrigin>) =>
  vi.fn(() => Promise.resolve(new Map(Object.entries(entries))));

describe('drift tracker (absorption)', () => {
  let log: ReturnType<typeof vi.fn>;
  let reread: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    log = vi.fn();
    reread = vi.fn().mockResolvedValue(true);
  });

  const make = (currentOrigins: () => Promise<Map<string, ResolvedOrigin>>) =>
    createDriftTracker({ currentOrigins, reread, log });

  it('never re-reads a plugin still resolving to the origin it was loaded from', async () => {
    const tracker = make(currently({ 'foo.esp': { origin: 'ModA', path: '/mods/A/Foo.esp' } }));
    tracker.setLoaded(new Map([['Foo.esp', 'ModA']]));

    await tracker.refresh();

    expect(reread).not.toHaveBeenCalled();
  });

  it('re-reads a plugin now resolving to a different mod, from the resolved path and origin', async () => {
    const tracker = make(currently({ 'foo.esp': { origin: 'ModB', path: '/mods/B/Foo.esp' } }));
    tracker.setLoaded(new Map([['Foo.esp', 'ModA']]));

    await tracker.refresh();

    expect(reread).toHaveBeenCalledWith('Foo.esp', '/mods/B/Foo.esp', 'ModB');
  });

  // Uninstalling the only provider of a loaded plugin. The records stay browsable; there is simply
  // nothing left to re-read.
  it('never re-reads a plugin whose name now resolves to nothing', async () => {
    const tracker = make(currently({ 'foo.esp': null }));
    tracker.setLoaded(new Map([['Foo.esp', 'ModA']]));

    await tracker.refresh();

    expect(reread).not.toHaveBeenCalled();
  });

  it('matches the loaded plugin to its current origin case-insensitively', async () => {
    const tracker = make(currently({ 'foo.esp': { origin: 'ModA', path: '/mods/A/Foo.esp' } }));
    tracker.setLoaded(new Map([['FOO.ESP', 'moda']]));

    await tracker.refresh();

    // Neither the filename nor the origin is authoritative about its own casing — plugins.txt and
    // mods/ both come off a case-insensitive filesystem in practice.
    expect(reread).not.toHaveBeenCalled();
  });

  // The load-bearing fix #356 made: without folding a success back into the tracker's own
  // baseline, every future mod-level change anywhere would still find this plugin "drifted"
  // against its stale original origin and re-read it again — forever. Rival: the pre-#356 tracker,
  // which only ever updated its baseline via `setLoaded` (a full session load/close), never from
  // inside `refresh` itself.
  it('does not re-read a plugin again on a later refresh once nothing further has changed', async () => {
    const currentOrigins = currently({ 'foo.esp': { origin: 'ModB', path: '/mods/B/Foo.esp' } });
    const tracker = make(currentOrigins);
    tracker.setLoaded(new Map([['Foo.esp', 'ModA']]));

    await tracker.refresh();
    expect(reread).toHaveBeenCalledTimes(1);

    // Rival, applied: comment out `held.set(file, drift.currentOrigin)` in pluginDrift.ts's
    // `doRefresh` and re-run this suite — this assertion is the one that catches it, failing with
    // `reread` called a second time here (observed: "expected 1, received 2").
    await tracker.refresh();

    expect(reread).toHaveBeenCalledTimes(1);
  });

  it('a failed re-read is retried on the next refresh, not looped internally', async () => {
    reread.mockResolvedValueOnce(false);
    const currentOrigins = currently({ 'foo.esp': { origin: 'ModB', path: '/mods/B/Foo.esp' } });
    const tracker = make(currentOrigins);
    tracker.setLoaded(new Map([['Foo.esp', 'ModA']]));

    await tracker.refresh();
    expect(reread).toHaveBeenCalledTimes(1);

    reread.mockResolvedValueOnce(true);
    await tracker.refresh();

    expect(reread).toHaveBeenCalledTimes(2);
  });

  it('a rejected re-read is treated as a failure rather than thrown', async () => {
    reread.mockRejectedValueOnce(new Error('backend busy'));
    const tracker = make(currently({ 'foo.esp': { origin: 'ModB', path: '/mods/B/Foo.esp' } }));
    tracker.setLoaded(new Map([['Foo.esp', 'ModA']]));

    await expect(tracker.refresh()).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('backend busy'));
  });

  // #334's rule, at this seam: absorption must never act on a failed computation. "No drift" and
  // "could not tell" must not be conflated into a re-read attempt.
  it('a failed origin walk absorbs nothing and logs, rather than guessing', async () => {
    const currentOrigins = vi.fn()
      .mockResolvedValueOnce(new Map<string, ResolvedOrigin>([['foo.esp', { origin: 'ModB', path: '/mods/B/Foo.esp' }]]))
      .mockRejectedValueOnce(new Error('mods/ walk failed'));
    const tracker = make(currentOrigins as () => Promise<Map<string, ResolvedOrigin>>);
    tracker.setLoaded(new Map([['Foo.esp', 'ModA']]));

    await tracker.refresh();
    expect(reread).toHaveBeenCalledTimes(1);

    await tracker.refresh();

    expect(reread).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('mods/ walk failed'));
  });

  it('closing the session drops the baseline without asking Mod Management anything', async () => {
    const currentOrigins = currently({ 'foo.esp': { origin: 'ModB', path: '/mods/B/Foo.esp' } });
    const tracker = make(currentOrigins);
    tracker.setLoaded(new Map([['Foo.esp', 'ModA']]));

    tracker.setLoaded(undefined);
    await tracker.refresh();

    expect(currentOrigins).not.toHaveBeenCalled();
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

  // A name the session holds but Mod Management never answered for is not "no drift" — it is the
  // same unknown as a failed walk, one row wide, and must not be re-read on a guess.
  it('never re-reads a plugin the current-origin answer omits entirely', async () => {
    const tracker = make(currently({}));
    tracker.setLoaded(new Map([['Foo.esp', 'ModA']]));

    await tracker.refresh();

    expect(reread).not.toHaveBeenCalled();
  });

  // The addition #356's own review asked for: two debounced watchers (modlist.txt, mods/**) can
  // both fire for one mod-level change, so two `refresh()` calls can be in flight at once. Rival:
  // a `refresh()` with no serialization, which starts a second `currentOrigins` walk before the
  // first has finished — applied by dropping the `tail` chaining in `refresh()`, this test then
  // fails on the first assertion below (observed: `currentOrigins` called twice before the first
  // call's deferred promise ever resolves).
  it('serializes overlapping refreshes so two absorption passes never race the same plugin', async () => {
    let resolveFirst!: (v: Map<string, ResolvedOrigin>) => void;
    const first = new Promise<Map<string, ResolvedOrigin>>((res) => { resolveFirst = res; });
    const currentOrigins = vi.fn()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce(new Map<string, ResolvedOrigin>());
    const tracker = createDriftTracker({ currentOrigins, reread, log });
    tracker.setLoaded(new Map([['Foo.esp', 'ModA']]));

    const p1 = tracker.refresh();
    const p2 = tracker.refresh();
    await Promise.resolve();
    await Promise.resolve();

    // The second refresh's own walk must not have started while the first is still in flight.
    expect(currentOrigins).toHaveBeenCalledTimes(1);

    resolveFirst(new Map());
    await p1;
    await p2;

    expect(currentOrigins).toHaveBeenCalledTimes(2);
  });

  // A session close (or a fresh load) landing mid-absorption owns the answer, not the in-flight
  // pass — the mirror image of the "failed walk" guard, but for the reread half rather than the
  // currentOrigins half. Rival: a `doRefresh` that skips the `loaded !== held` re-check after each
  // `deps.reread` await, which lets a stale pass keep reading further plugins after the session it
  // was absorbing for is already gone — applied here, the second plugin's `reread` fires anyway
  // (observed: called twice instead of once).
  it('stops absorbing mid-pass when the session closes underneath it', async () => {
    let resolveReread!: (ok: boolean) => void;
    const rereadGate = new Promise<boolean>((res) => { resolveReread = res; });
    reread.mockReturnValueOnce(rereadGate);
    const tracker = createDriftTracker({
      currentOrigins: currently({
        'foo.esp': { origin: 'ModB', path: '/mods/B/Foo.esp' },
        'bar.esp': { origin: 'ModD', path: '/mods/D/Bar.esp' },
      }),
      reread,
      log,
    });
    tracker.setLoaded(new Map([['Foo.esp', 'ModA'], ['Bar.esp', 'ModC']]));

    const running = tracker.refresh();
    // Pump microtasks until Foo.esp's re-read is reached — `refresh()`'s own tail-chaining and the
    // `currentOrigins` await each cost a tick before `doRefresh`'s loop gets there.
    for (let i = 0; i < 5 && reread.mock.calls.length === 0; i++) await Promise.resolve();
    expect(reread).toHaveBeenCalledTimes(1); // Foo.esp's re-read is in flight; Bar.esp not reached yet

    tracker.setLoaded(undefined);
    resolveReread(true);
    await running;

    // Bar.esp's own re-read must never have been attempted once the session it belonged to closed.
    expect(reread).toHaveBeenCalledTimes(1);
  });

  it('exposes nothing beyond the hand-off it needs — no decoration surface is left to wire up', () => {
    const tracker = make(currently({}));
    expect(Object.keys(tracker).sort()).toEqual(['dispose', 'refresh', 'setLoaded']);
  });
});

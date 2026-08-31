import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createLoadOrderSync, createReconcileSequencer, type ReconcileStepDeps, type LoadOrderSyncDeps,
} from '../loadOrderReconcile';

/** A fully-populated `LoadOrderSyncDeps` fixture — every step defaults to a no-op/resolved fake,
 *  overridden per test with just the ones a test cares about. Shared across every
 *  `createLoadOrderSync` describe block below (the coalescing wrapper, the matches/setMatches
 *  store, arm/abandon) since none of them need a different base shape, only different overrides. */
function makeSyncDeps(over: Partial<LoadOrderSyncDeps> = {}): LoadOrderSyncDeps {
  return {
    isReceiving: () => true,
    debounceMs: 100,
    log: vi.fn(),
    withProgress: (work: () => Promise<void>) => work(),
    say: vi.fn(),
    logInfo: vi.fn(),
    notifyNoGameDirectory: vi.fn(),
    resolveGameDirectory: vi.fn().mockResolvedValue({ dataFolder: '/data' }),
    buildSnapshot: vi.fn().mockResolvedValue([]),
    makeProgressHandler: () => ({ onProgress: vi.fn(), lastTotalPlugins: () => 0 }),
    putLoadOrder: vi.fn().mockResolvedValue({ outcome: 'reconciled', failures: [], crashRepairOffers: [] }),
    syncFilterState: vi.fn().mockResolvedValue(undefined),
    applyReconciled: vi.fn().mockResolvedValue(undefined),
    presentCrashRepairOffers: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

// ADR-0044: every loadout gesture becomes "recompute the snapshot, PUT it", and bursts
// coalesce — one PUT per settled change, never a race of two. `putLoadOrder` stands in for the
// whole reconcile as the one call every "did a send happen" assertion below spies on — the
// sequencing itself (arm, resolve the game directory, build the snapshot, PUT, apply) is its own
// module, `createReconcileSequencer`, and unit-tested on its own further down; these tests are
// about the debounce/coalescing/single-flight wrapper around it, unchanged in shape from when
// `send` was one opaque function instead of these named steps.
describe('createLoadOrderSync', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const make = (over: Partial<LoadOrderSyncDeps> = {}) => {
    const deps = makeSyncDeps(over);
    const sync = createLoadOrderSync(deps);
    return { sync, putLoadOrder: deps.putLoadOrder, log: deps.log };
  };

  it('coalesces a burst of requests into one send after the debounce window', async () => {
    const { sync, putLoadOrder } = make();

    sync.request();
    sync.request();
    sync.request();
    expect(putLoadOrder).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);

    expect(putLoadOrder).toHaveBeenCalledTimes(1);
  });

  it('drops a request silently when nothing is receiving — a loadout-only workspace is the ordinary case', async () => {
    const { sync, putLoadOrder, log } = make({ isReceiving: () => false });

    sync.request();
    await vi.advanceTimersByTimeAsync(100);

    expect(putLoadOrder).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('no receiver'));
  });

  it('a request that lands mid-send becomes exactly one more send after it, never a concurrent one', async () => {
    let resolveFirst!: () => void;
    const putLoadOrder = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveFirst = () => resolve({ outcome: 'reconciled', failures: [], crashRepairOffers: [] });
      }))
      .mockResolvedValue({ outcome: 'reconciled', failures: [], crashRepairOffers: [] });
    const { sync } = make({ putLoadOrder });

    sync.request();
    await vi.advanceTimersByTimeAsync(100);
    expect(putLoadOrder).toHaveBeenCalledTimes(1);

    sync.request();
    sync.request();
    await vi.advanceTimersByTimeAsync(100);
    expect(putLoadOrder).toHaveBeenCalledTimes(1); // still in flight — nothing concurrent

    resolveFirst();
    await vi.advanceTimersByTimeAsync(0);

    expect(putLoadOrder).toHaveBeenCalledTimes(2);
  });

  it('flush sends now and folds a pending debounced request into that send', async () => {
    const { sync, putLoadOrder } = make();

    sync.request();
    await sync.flush();
    await vi.advanceTimersByTimeAsync(200);

    expect(putLoadOrder).toHaveBeenCalledTimes(1);
  });

  // Review finding (#608): flush() joining an in-flight send (this test) is the one case where
  // "the run flush() itself caused" and "the run that happens after the one it joined" are the
  // same run — flush's own join is what makes that follow-up happen — so flush correctly sees run
  // #2's outcome here. The distinct, buggy case is the next test: flush *starting* a run, with
  // someone else's request joining midway. Two different outcome values (not the same
  // 'reconciled' both times, as this test used to use) pin which run flush is actually reporting.
  it('flush waits for an in-flight send to finish, then sends once more of its own', async () => {
    let resolveFirst!: () => void;
    const putLoadOrder = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveFirst = () => resolve({ outcome: 'failed' });
      }))
      .mockResolvedValue({ outcome: 'reconciled', failures: [], crashRepairOffers: [] });
    const { sync } = make({ putLoadOrder });

    sync.request();
    await vi.advanceTimersByTimeAsync(100);
    const flushed = sync.flush();
    resolveFirst();
    const outcome = await flushed;

    expect(putLoadOrder).toHaveBeenCalledTimes(2);
    // flush's own send is the second call — the one its join caused — not the first, which was
    // already running before flush was ever invoked.
    expect(outcome).toBe('reconciled');
  });

  // Review finding (#608), the concrete failure the reviewer traced: Launch mEdit's flush()
  // starts its own run; a watcher's request() fires mid-PUT and coalesces into exactly one more
  // run (never a concurrent one — the shared single-flight gate is unchanged); flush must still
  // resolve with *its own* run's outcome, not the coalesced run's, or `makeEnterEditing` would
  // read a stranger's 'no-game-directory' and tear down a view that just launched successfully.
  it('flush resolves with the outcome of the run it caused, not a later run a concurrent request coalesces into it', async () => {
    let resolveGameDirectory!: (v: { dataFolder: string } | undefined) => void;
    const resolveGameDirectoryFn = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveGameDirectory = resolve; }))
      .mockResolvedValue({ dataFolder: '/data' });
    const putLoadOrder = vi.fn()
      .mockResolvedValueOnce({ outcome: 'failed' }) // flush's own run
      .mockResolvedValueOnce({ outcome: 'reconciled', failures: [], crashRepairOffers: [] }); // the coalesced request()'s run
    const { sync } = make({ resolveGameDirectory: resolveGameDirectoryFn, putLoadOrder });

    const flushed = sync.flush(); // starts flush's own run — blocked on resolveGameDirectory
    sync.request(); // a watcher fires while flush's PUT is still building its snapshot
    await vi.advanceTimersByTimeAsync(100); // the watcher's debounce timer fires -> coalesces in

    resolveGameDirectory({ dataFolder: '/data' }); // let flush's own run proceed
    const outcome = await flushed;
    // The coalesced follow-up run starts the instant flush's own run settles (`handleSettled`),
    // but still needs its own microtask turns (resolveGameDirectory -> buildSnapshot ->
    // putLoadOrder) to actually reach its PUT — give it those before checking it landed.
    await vi.advanceTimersByTimeAsync(0);

    expect(outcome).toBe('failed'); // flush's own run's outcome — never the coalesced 'reconciled'
    expect(putLoadOrder).toHaveBeenCalledTimes(2); // the watcher's need was not dropped either
  });

  it('a throwing send is logged and does not wedge the next request', async () => {
    const putLoadOrder = vi.fn().mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue({ outcome: 'reconciled', failures: [], crashRepairOffers: [] });
    const { sync, log } = make({ putLoadOrder });

    sync.request();
    await vi.advanceTimersByTimeAsync(100);
    sync.request();
    await vi.advanceTimersByTimeAsync(100);

    expect(putLoadOrder).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });

  it('a disposed sync sends nothing', async () => {
    const { sync, putLoadOrder } = make();

    sync.request();
    sync.dispose();
    await vi.advanceTimersByTimeAsync(100);

    expect(putLoadOrder).not.toHaveBeenCalled();
  });

  // The doc comment on `flush()` said this was the intended shape from the start ("wants the
  // snapshot's outcome rather than a promise that one will happen") before any caller actually
  // needed it — now `makeEnterEditing` does, calling `flush()` directly instead of a separately
  // threaded reconcile function.
  it('flush resolves with the reconcile\'s own outcome', async () => {
    const { sync } = make();

    await expect(sync.flush()).resolves.toBe('reconciled');
  });

  it('flush resolves with no-game-directory when there is nothing to build a snapshot from', async () => {
    const { sync } = make({ resolveGameDirectory: vi.fn().mockResolvedValue(undefined) });

    await expect(sync.flush()).resolves.toBe('no-game-directory');
  });
});

// ADR-0035 amending ADR-0018: the per-plugin record-filter match map used to be a module-level
// `let` in extension.ts with four independent writers (a completed reconcile, EditingController's
// setFilter/clearFilter, mEdit closing, and a dead backend) and one reader (the composite's
// hasMatchingRecords). Folded in here as the module's one owner — a pure store, not a
// recomputation: this module never decides *what* matches, only holds what it was told.
describe('createLoadOrderSync — matches/setMatches', () => {
  const make = () => createLoadOrderSync(makeSyncDeps());

  it('reads undefined for any file before anything is ever set', () => {
    const sync = make();

    expect(sync.matches('a.esp')).toBeUndefined();
  });

  it('setMatches is a pure assignment — matches reads back exactly what was set, nothing transformed', () => {
    const sync = make();

    sync.setMatches(new Map([['a.esp', true], ['b.esp', false]]));

    expect(sync.matches('a.esp')).toBe(true);
    expect(sync.matches('b.esp')).toBe(false);
    expect(sync.matches('c.esp')).toBeUndefined();
  });

  it('setMatches(undefined) clears it back to "matches everywhere"', () => {
    const sync = make();

    sync.setMatches(new Map([['a.esp', false]]));
    sync.setMatches(undefined);

    expect(sync.matches('a.esp')).toBeUndefined();
  });
});

// The in-flight reconcile's abort handle used to be a module-level `let loadAbort` in
// extension.ts, replaced by each new reconcile (armLoadAbort) and cancelled by exitToLoadout —
// two lifecycles that must stay independent: cancelling the in-flight reconcile must never
// disable a later request()/flush() the same object goes on to serve (launch → close → launch).
describe('createLoadOrderSync — arm/abandon', () => {
  const make = () => createLoadOrderSync(makeSyncDeps());

  it('a freshly armed scope is not abandoned', () => {
    const sync = make();

    const { signal, abandoned } = sync.arm();

    expect(signal.aborted).toBe(false);
    expect(abandoned()).toBe(false);
  });

  it('abandon() aborts the most recently armed scope', () => {
    const sync = make();
    const { signal, abandoned } = sync.arm();

    sync.abandon();

    expect(signal.aborted).toBe(true);
    expect(abandoned()).toBe(true);
  });

  it('abandon() is a silent no-op when nothing has ever been armed', () => {
    const sync = make();

    expect(() => sync.abandon()).not.toThrow();
  });

  // A superseded reconcile does not need aborting — the backend answers it 409 (armLoadAbort's
  // own former comment) — so arming again must not reach back and abort the scope it replaces.
  it('arming again does not abort the previous scope, only replaces it', () => {
    const sync = make();
    const first = sync.arm();
    const second = sync.arm();

    sync.abandon();

    expect(first.signal.aborted).toBe(false);
    expect(second.signal.aborted).toBe(true);
  });
});

// ADR-0044: one reconcile — recompute the snapshot, PUT it, hand the backend's answer to the
// tree — ported verbatim from extension.ts's own reconcileOnce/reconcile (makeReconcileLoadOrder),
// now driven entirely by injected steps so the branching (reconciled/failed/abandoned/
// no-game-directory) and the tail-chained single-flight guarantee are unit-testable without a
// VS Code harness.
describe('createReconcileSequencer', () => {
  const makeDeps = (over: Partial<ReconcileStepDeps> = {}, order: string[] = []): ReconcileStepDeps => {
    const abandoned = false;
    return {
      arm: () => ({ signal: new AbortController().signal, abandoned: () => abandoned }),
      say: vi.fn((msg) => order.push(`say:${String(msg)}`)),
      logInfo: vi.fn(),
      notifyNoGameDirectory: vi.fn(() => order.push('notifyNoGameDirectory')),
      resolveGameDirectory: vi.fn(() => { order.push('resolveGameDirectory'); return Promise.resolve({ dataFolder: '/data' }); }),
      buildSnapshot: vi.fn(() => { order.push('buildSnapshot'); return Promise.resolve(['a.esp']); }),
      makeProgressHandler: () => ({ onProgress: vi.fn(), lastTotalPlugins: () => 1 }),
      putLoadOrder: vi.fn(() => {
        order.push('putLoadOrder');
        return Promise.resolve({ outcome: 'reconciled' as const, failures: [], crashRepairOffers: [] });
      }),
      syncFilterState: vi.fn(() => { order.push('syncFilterState'); return Promise.resolve(); }),
      applyReconciled: vi.fn(() => { order.push('applyReconciled'); return Promise.resolve(); }),
      presentCrashRepairOffers: vi.fn(() => { order.push('presentCrashRepairOffers'); return Promise.resolve(); }),
      ...over,
    };
  };

  it('runs the happy path in order and returns reconciled', async () => {
    const order: string[] = [];
    const deps = makeDeps({}, order);
    const { reconcile } = createReconcileSequencer(deps);

    const outcome = await reconcile();

    expect(outcome).toBe('reconciled');
    expect(order).toEqual([
      'resolveGameDirectory', 'say:Building the load order snapshot…',
      'buildSnapshot', 'putLoadOrder', 'syncFilterState', 'applyReconciled',
    ]);
    expect(deps.applyReconciled).toHaveBeenCalledWith([], 1);
  });

  it('returns no-game-directory and notifies, without ever building a snapshot', async () => {
    const order: string[] = [];
    const deps = makeDeps({ resolveGameDirectory: vi.fn().mockResolvedValue(undefined) }, order);
    const { reconcile } = createReconcileSequencer(deps);

    const outcome = await reconcile();

    expect(outcome).toBe('no-game-directory');
    expect(deps.notifyNoGameDirectory).toHaveBeenCalledTimes(1);
    expect(deps.buildSnapshot).not.toHaveBeenCalled();
  });

  it('returns abandoned without building a snapshot when abandoned right after the game directory resolves', async () => {
    const deps = makeDeps({
      arm: () => ({ signal: new AbortController().signal, abandoned: () => true }),
    });
    const { reconcile } = createReconcileSequencer(deps);

    const outcome = await reconcile();

    expect(outcome).toBe('abandoned');
    expect(deps.buildSnapshot).not.toHaveBeenCalled();
  });

  it('returns abandoned without sending the snapshot when abandoned after it is built', async () => {
    let abandonedAfterBuild = false;
    const deps = makeDeps({
      arm: () => ({ signal: new AbortController().signal, abandoned: () => abandonedAfterBuild }),
      buildSnapshot: vi.fn(() => { abandonedAfterBuild = true; return Promise.resolve(['a.esp']); }),
    });
    const { reconcile } = createReconcileSequencer(deps);

    const outcome = await reconcile();

    expect(outcome).toBe('abandoned');
    expect(deps.putLoadOrder).not.toHaveBeenCalled();
  });

  it('returns abandoned, without syncing filter state or applying, when putLoadOrder itself reports abandoned', async () => {
    const deps = makeDeps({
      putLoadOrder: vi.fn().mockResolvedValue({ outcome: 'abandoned', failures: [], crashRepairOffers: [] }),
    });
    const { reconcile } = createReconcileSequencer(deps);

    const outcome = await reconcile();

    expect(outcome).toBe('abandoned');
    expect(deps.syncFilterState).not.toHaveBeenCalled();
    expect(deps.applyReconciled).not.toHaveBeenCalled();
  });

  it('returns failed, without syncing filter state or applying, when putLoadOrder reports failed', async () => {
    const deps = makeDeps({
      putLoadOrder: vi.fn().mockResolvedValue({ outcome: 'failed', failures: [], crashRepairOffers: [] }),
    });
    const { reconcile } = createReconcileSequencer(deps);

    const outcome = await reconcile();

    expect(outcome).toBe('failed');
    expect(deps.syncFilterState).not.toHaveBeenCalled();
    expect(deps.applyReconciled).not.toHaveBeenCalled();
  });

  it('presents crash-repair offers only when putLoadOrder reports any', async () => {
    const noOffers = makeDeps();
    await createReconcileSequencer(noOffers).reconcile();
    expect(noOffers.presentCrashRepairOffers).not.toHaveBeenCalled();

    const withOffers = makeDeps({
      putLoadOrder: vi.fn().mockResolvedValue({ outcome: 'reconciled', failures: [], crashRepairOffers: ['offer-1'] }),
    });
    await createReconcileSequencer(withOffers).reconcile();
    expect(withOffers.presentCrashRepairOffers).toHaveBeenCalledWith(['offer-1']);
  });

  // Review finding (#608): this sequencer used to tail-chain overlapping reconcile() calls so a
  // caller reaching it while one was still running got its own queued-after run rather than a
  // concurrent one. That guard is gone — createLoadOrderSync is this sequencer's sole caller
  // (its own request()/flush() coalescing, via `schedule()`, is what now guarantees only one
  // reconcile() call is ever in flight at a time), so a second guard here had nothing left to
  // guard against. This test pins the honest consequence: called directly, with no serializing
  // caller in front of it, two concurrent reconcile() calls now race — proving the doc comment
  // above true rather than merely asserting it. A future caller invoking this sequencer from more
  // than one unsynchronized place would need to bring its own serialization.
  it('does not serialize overlapping reconcile() calls on its own — two concurrent calls race', async () => {
    let resolveFirst!: () => void;
    const order: string[] = [];
    // Only resolveGameDirectory/putLoadOrder are tracked here — the other steps are real no-op
    // fakes (not the order-pushing defaults from makeDeps) so the trace stays legible.
    const deps: ReconcileStepDeps = {
      arm: () => ({ signal: new AbortController().signal, abandoned: () => false }),
      say: vi.fn(),
      logInfo: vi.fn(),
      notifyNoGameDirectory: vi.fn(),
      resolveGameDirectory: vi.fn()
        .mockImplementationOnce(() => new Promise((resolve) => {
          resolveFirst = () => { order.push('resolveGameDirectory:1'); resolve({ dataFolder: '/data' }); };
        }))
        .mockImplementationOnce(() => { order.push('resolveGameDirectory:2'); return Promise.resolve({ dataFolder: '/data' }); }),
      buildSnapshot: vi.fn().mockResolvedValue(['a.esp']),
      makeProgressHandler: () => ({ onProgress: vi.fn(), lastTotalPlugins: () => 1 }),
      putLoadOrder: vi.fn(() => {
        order.push('putLoadOrder');
        return Promise.resolve({ outcome: 'reconciled' as const, failures: [], crashRepairOffers: [] });
      }),
      syncFilterState: vi.fn().mockResolvedValue(undefined),
      applyReconciled: vi.fn().mockResolvedValue(undefined),
      presentCrashRepairOffers: vi.fn().mockResolvedValue(undefined),
    };
    const { reconcile } = createReconcileSequencer(deps);

    const first = reconcile();
    const second = reconcile();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    // Both calls started immediately, concurrently — the second ran all the way through to its
    // own PUT while the first is still blocked on its very first await, not waiting for the first
    // to finish the way the tail-chain used to make it.
    expect(order).toEqual(['resolveGameDirectory:2', 'putLoadOrder']);

    resolveFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['resolveGameDirectory:2', 'putLoadOrder', 'resolveGameDirectory:1', 'putLoadOrder']);
  });
});

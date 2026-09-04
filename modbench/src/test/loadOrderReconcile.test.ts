import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createLoadOrderSync, createReconcileSequencer, type ReconcileStepDeps, type LoadOrderSyncDeps,
} from '../loadOrderReconcile';

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

// ADR-0044: every loadout gesture becomes "recompute the snapshot, PUT it", one PUT per settled
// change, never a race of two. `putLoadOrder` stands in for the whole reconcile as the one call
// every send assertion spies on.
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

  // flush() joining an in-flight send is the one case where the run it caused and the run after
  // the one it joined coincide, so flush sees run #2's outcome. Two distinct outcome values
  // pin which run flush reports.
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

  // flush() starts its own run; a watcher's request() mid-PUT coalesces into one more run, so
  // flush must resolve with its own outcome or makeEnterEditing tears down a fresh launch.
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

  // `makeEnterEditing` calls `flush()` directly and wants the snapshot's outcome, not a promise
  // that one will happen.
  it('flush resolves with the reconcile\'s own outcome', async () => {
    const { sync } = make();

    await expect(sync.flush()).resolves.toBe('reconciled');
  });

  it('flush resolves with no-game-directory when there is nothing to build a snapshot from', async () => {
    const { sync } = make({ resolveGameDirectory: vi.fn().mockResolvedValue(undefined) });

    await expect(sync.flush()).resolves.toBe('no-game-directory');
  });
});

// ADR-0035 amending ADR-0018: this module owns the per-plugin record-filter match map as a pure
// store — it never decides what matches, only holds what it was told.
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

// The in-flight reconcile's abort handle and the object's own lifecycle stay independent:
// cancelling the in-flight reconcile must never disable a later request()/flush() (launch →
// close → launch).
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
// tree — driven entirely by injected steps so the branching and the tail-chained single-flight
// guarantee are testable without a VS Code harness.
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

  // The coalescing above guarantees one reconcile() in flight at a time, so the sequencer
  // serializes nothing itself: called directly, two concurrent reconcile() calls race.
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

    // Both calls start concurrently — the second runs through to its own PUT while the first is
    // still blocked on its very first await.
    expect(order).toEqual(['resolveGameDirectory:2', 'putLoadOrder']);

    resolveFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['resolveGameDirectory:2', 'putLoadOrder', 'resolveGameDirectory:1', 'putLoadOrder']);
  });
});

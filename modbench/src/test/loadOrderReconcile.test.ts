import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLoadOrderSync, createReconcileSequencer, type ReconcileStepDeps } from '../loadOrderReconcile';

// ADR-0044: every loadout gesture becomes "recompute the snapshot, PUT it", and bursts
// coalesce — one PUT per settled change, never a race of two.
describe('createLoadOrderSync', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const make = (over: { isReceiving?: () => boolean; send?: () => Promise<void> } = {}) => {
    const send = over.send ?? vi.fn().mockResolvedValue(undefined);
    const log = vi.fn();
    const sync = createLoadOrderSync({ isReceiving: over.isReceiving ?? (() => true), send, debounceMs: 100, log });
    return { sync, send, log };
  };

  it('coalesces a burst of requests into one send after the debounce window', async () => {
    const { sync, send } = make();

    sync.request();
    sync.request();
    sync.request();
    expect(send).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('drops a request silently when nothing is receiving — a loadout-only workspace is the ordinary case', async () => {
    const { sync, send, log } = make({ isReceiving: () => false });

    sync.request();
    await vi.advanceTimersByTimeAsync(100);

    expect(send).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('no receiver'));
  });

  it('a request that lands mid-send becomes exactly one more send after it, never a concurrent one', async () => {
    let resolveFirst!: () => void;
    const send = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValue(undefined);
    const { sync } = make({ send });

    sync.request();
    await vi.advanceTimersByTimeAsync(100);
    expect(send).toHaveBeenCalledTimes(1);

    sync.request();
    sync.request();
    await vi.advanceTimersByTimeAsync(100);
    expect(send).toHaveBeenCalledTimes(1); // still in flight — nothing concurrent

    resolveFirst();
    await vi.advanceTimersByTimeAsync(0);

    expect(send).toHaveBeenCalledTimes(2);
  });

  it('flush sends now and folds a pending debounced request into that send', async () => {
    const { sync, send } = make();

    sync.request();
    await sync.flush();
    await vi.advanceTimersByTimeAsync(200);

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('flush waits for an in-flight send and then sends once more, so the caller sees the latest state', async () => {
    let resolveFirst!: () => void;
    const send = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValue(undefined);
    const { sync } = make({ send });

    sync.request();
    await vi.advanceTimersByTimeAsync(100);
    const flushed = sync.flush();
    resolveFirst();
    await flushed;

    expect(send).toHaveBeenCalledTimes(2);
  });

  it('a throwing send is logged and does not wedge the next request', async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined);
    const { sync, log } = make({ send });

    sync.request();
    await vi.advanceTimersByTimeAsync(100);
    sync.request();
    await vi.advanceTimersByTimeAsync(100);

    expect(send).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });

  it('a disposed sync sends nothing', async () => {
    const { sync, send } = make();

    sync.request();
    sync.dispose();
    await vi.advanceTimersByTimeAsync(100);

    expect(send).not.toHaveBeenCalled();
  });
});

// ADR-0035 amending ADR-0018: the per-plugin record-filter match map used to be a module-level
// `let` in extension.ts with four independent writers (a completed reconcile, EditingController's
// setFilter/clearFilter, mEdit closing, and a dead backend) and one reader (the composite's
// hasMatchingRecords). Folded in here as the module's one owner — a pure store, not a
// recomputation: this module never decides *what* matches, only holds what it was told.
describe('createLoadOrderSync — matches/setMatches', () => {
  const make = () => createLoadOrderSync({
    isReceiving: () => true, send: vi.fn().mockResolvedValue(undefined), debounceMs: 100, log: vi.fn(),
  });

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
  const make = () => createLoadOrderSync({
    isReceiving: () => true, send: vi.fn().mockResolvedValue(undefined), debounceMs: 100, log: vi.fn(),
  });

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

  // The tail-chaining this ports verbatim from makeReconcileLoadOrder: a caller reaching
  // reconcile() while one is still running gets its own freshly-sequenced run queued after it,
  // never a concurrent one racing it.
  it('serializes overlapping reconcile() calls rather than racing them', async () => {
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
    await Promise.resolve(); await Promise.resolve(); // let the tail-chained microtask reach resolveGameDirectory
    expect(order).toEqual([]); // first call is waiting on its own game directory resolution

    resolveFirst();
    await first;
    expect(order).toEqual(['resolveGameDirectory:1', 'putLoadOrder']); // second still queued behind it

    await second;
    expect(order).toEqual(['resolveGameDirectory:1', 'putLoadOrder', 'resolveGameDirectory:2', 'putLoadOrder']);
  });
});

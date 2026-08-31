import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLoadOrderSync } from '../loadOrderReconcile';

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

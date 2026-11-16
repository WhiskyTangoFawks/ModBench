import { describe, it, expect, vi } from 'vitest';
import type { PluginLoadFailure } from '../MEditClient';
import { InMemoryMEditClient } from './InMemoryMEditClient';
import { loadOrderStatusEventFixture } from './fixtures';

const tick = (conflictsComputed: boolean, failures: PluginLoadFailure[] = [], version = 1) =>
  loadOrderStatusEventFixture({ conflictsComputed, failures, version });

const bad = { name: 'Bad.esp', origin: 'Mod', reason: 'truncated' };

describe('the client\'s load-order status', () => {
  it('is undefined before the first tick', () => {
    expect(new InMemoryMEditClient().loadOrderStatus).toBeUndefined();
  });

  it('reads the latest tick', () => {
    const client = new InMemoryMEditClient();

    client.emit(tick(true, [bad]));
    expect(client.loadOrderStatus?.conflictsComputed).toBe(true);
    expect(client.loadOrderStatus?.failures).toEqual([bad]);

    client.emit(tick(false));
    expect(client.loadOrderStatus?.conflictsComputed).toBe(false);
    expect(client.loadOrderStatus?.failures).toEqual([]);
  });

  it('resets when the backend leaves running, so a restarted process\'s reconcile starts unsettled', () => {
    const client = new InMemoryMEditClient();
    client.emit(tick(true));

    client.setStatus('disconnected');

    expect(client.loadOrderStatus).toBeUndefined();
  });

  it('resets when the stream reopens, since it may have reattached to another process', () => {
    const client = new InMemoryMEditClient();
    client.emit(tick(true));

    client.reconnected();

    expect(client.loadOrderStatus).toBeUndefined();
  });

  it('tells the status listener every tick, and a reset with undefined, held or not', () => {
    const client = new InMemoryMEditClient();
    const seen: (boolean | undefined)[] = [];
    client.onLoadOrderStatus((status) => seen.push(status?.conflictsComputed));

    client.setStatus('disconnected');
    client.emit(tick(false));
    client.emit(tick(false));
    client.emit(tick(true));
    client.reconnected();

    expect(seen).toEqual([undefined, false, false, true, undefined]);
  });

  describe('the change event, on a status heard', () => {
    it('is told for each ready status newer than the last settled one, even when its picture is the last\'s', () => {
      const client = new InMemoryMEditClient();
      const changed = vi.fn();
      client.onDidChange(changed);

      client.emit(tick(true, [], 1));
      client.emit(tick(true, [], 1));
      client.emit(tick(true, [], 2));

      expect(changed).toHaveBeenCalledTimes(2);
    });

    it('is told when a reconcile of the version already settled, as a refresh runs, becomes ready', () => {
      const client = new InMemoryMEditClient();
      client.emit(tick(true, [], 1));
      const changed = vi.fn();
      client.onDidChange(changed);

      client.emit(tick(false, [], 1));
      client.emit(tick(true, [], 1));

      expect(changed).toHaveBeenCalledOnce();
    });

    it('is not told when a sweep over a named change stops validating, as that change was named', () => {
      const client = new InMemoryMEditClient();
      client.emit(loadOrderStatusEventFixture({ conflictsComputed: true, validating: false, version: 1 }));
      const changed = vi.fn();
      client.onDidChange(changed);

      client.emit(loadOrderStatusEventFixture({ conflictsComputed: true, validating: true, version: 1 }));
      client.emit(loadOrderStatusEventFixture({ conflictsComputed: true, validating: false, version: 1 }));

      expect(changed).not.toHaveBeenCalled();
    });

    it('is not told when a reconcile starts, or while it runs', () => {
      const client = new InMemoryMEditClient();
      client.emit(tick(true, [], 1));
      const changed = vi.fn();
      client.onDidChange(changed);

      client.emit(tick(false, [], 2));
      client.emit(tick(false, [], 2));

      expect(changed).not.toHaveBeenCalled();
    });

    it('is told, with the new failures already readable, when the failures differ, and not when they repeat', () => {
      const client = new InMemoryMEditClient();
      const seen: unknown[] = [];
      client.onDidChange(() => seen.push(client.loadOrderStatus?.failures.length));

      client.emit(tick(false, [bad]));
      client.emit(tick(false, [{ ...bad }]));
      client.emit(tick(false));

      expect(seen).toEqual([1, 0]);
    });

    it('is not told of a reset, and the next process\'s versions start over', () => {
      const client = new InMemoryMEditClient();
      client.emit(tick(true, [], 5));
      const changed = vi.fn();
      client.onDidChange(changed);

      client.setStatus('disconnected');
      expect(changed).not.toHaveBeenCalled();

      client.emit(tick(true, [], 1));
      expect(changed).toHaveBeenCalledOnce();
    });

    it('is told when a refusal arrives, and when it lifts, though no reconcile settled', () => {
      const client = new InMemoryMEditClient();
      client.emit(tick(false, [], 1));
      const changed = vi.fn();
      client.onDidChange(changed);

      client.emit(loadOrderStatusEventFixture({ state: 'HeldElsewhere', message: 'another window holds the record index', version: 1 }));
      client.emit(loadOrderStatusEventFixture({ state: 'HeldElsewhere', message: 'another window holds the record index', version: 1 }));
      expect(changed).toHaveBeenCalledOnce();

      client.emit(tick(false, [], 1));
      expect(changed).toHaveBeenCalledTimes(2);
    });

    it('is told when the load order is dropped, and when it is restored', () => {
      const client = new InMemoryMEditClient();
      client.emit(tick(true, [], 1));
      const changed = vi.fn();
      client.onDidChange(changed);

      client.emit(loadOrderStatusEventFixture({ state: 'None', conflictsComputed: false, version: 1 }));
      expect(changed).toHaveBeenCalledOnce();

      client.emit(tick(false, [], 1));
      expect(changed).toHaveBeenCalledTimes(2);
    });

    it('stops telling a listener once it unsubscribes', () => {
      const client = new InMemoryMEditClient();
      const changed = vi.fn();
      client.onDidChange(changed).dispose();

      client.emit(tick(true));

      expect(changed).not.toHaveBeenCalled();
    });
  });

  describe('the record index\'s progress', () => {
    it('is the plugins indexed or failed out of the load order, while it indexes, and the record index is late', () => {
      const client = new InMemoryMEditClient();
      const seen: unknown[] = [];
      client.onDidChangeRecordIndexProgress((progress) => seen.push(progress));

      client.emit(loadOrderStatusEventFixture({ conflictsComputed: false, totalPlugins: 3, indexedPlugins: [{ name: 'A.esp', origin: 'Mod' }], failures: [bad] }));

      expect([client.recordIndexProgress, seen, client.recordIndexMayBeLate]).toEqual([{ done: 2, total: 3 }, [{ done: 2, total: 3 }], true]);
    });

    it.each([
      ['the reconcile settles', (client: InMemoryMEditClient) => { client.emit(tick(true)); }],
      ['the load order is dropped', (client: InMemoryMEditClient) => { client.emit(loadOrderStatusEventFixture({ state: 'None', conflictsComputed: false })); }],
      ['the process is gone', (client: InMemoryMEditClient) => { client.setStatus('disconnected'); }],
    ])('is none once %s', (_case, end) => {
      const client = new InMemoryMEditClient();
      client.emit(tick(false));

      end(client);

      expect(client.recordIndexProgress).toBeUndefined();
    });

    it('is told only when it changes', () => {
      const client = new InMemoryMEditClient();
      const told = vi.fn();
      client.onDidChangeRecordIndexProgress(told);

      client.emit(tick(false));
      client.emit(tick(false));

      expect(told).toHaveBeenCalledOnce();
    });
  });
});

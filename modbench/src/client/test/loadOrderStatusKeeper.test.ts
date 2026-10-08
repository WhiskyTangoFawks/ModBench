import { describe, it, expect, vi } from 'vitest';
import type { NotificationEvent } from '../apiClient';
import type { PluginLoadFailure } from '../MEditClient';
import { InMemoryMEditClient } from './InMemoryMEditClient';

function tick(conflictsComputed: boolean, failures: PluginLoadFailure[] = [], version = 1): NotificationEvent {
  return {
    kind: 'load-order-status', plugin: '', origin: '', keys: [], sequence: 0,
    loadOrderStatus: {
      state: 'Ready', totalPlugins: 0, activePlugins: 0, indexedPlugins: [], conflictsComputed, failures, version,
    },
  };
}

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

  describe('a reconcile settled', () => {
    it('is told for each ready status newer than the last settled one, even when its picture is the last\'s', () => {
      const client = new InMemoryMEditClient();
      const settled = vi.fn();
      client.onLoadOrderSettled(settled);

      client.emit(tick(true, [], 1));
      client.emit(tick(true, [], 1));
      client.emit(tick(true, [], 2));

      expect(settled).toHaveBeenCalledTimes(2);
    });

    it('is not told when a reconcile starts, or while it runs', () => {
      const client = new InMemoryMEditClient();
      client.emit(tick(true, [], 1));
      const settled = vi.fn();
      client.onLoadOrderSettled(settled);

      client.emit(tick(false, [], 2));
      client.emit(tick(false, [], 2));

      expect(settled).not.toHaveBeenCalled();
    });

    it('is told, with the new failures already readable, when the failures differ, and not when they repeat', () => {
      const client = new InMemoryMEditClient();
      const seen: unknown[] = [];
      client.onLoadOrderSettled(() => seen.push(client.loadOrderStatus?.failures.length));

      client.emit(tick(false, [bad]));
      client.emit(tick(false, [{ ...bad }]));
      client.emit(tick(false));

      expect(seen).toEqual([1, 0]);
    });

    it('is not told of a reset, and the next process\'s versions start over', () => {
      const client = new InMemoryMEditClient();
      client.emit(tick(true, [], 5));
      const settled = vi.fn();
      client.onLoadOrderSettled(settled);

      client.setStatus('disconnected');
      expect(settled).not.toHaveBeenCalled();

      client.emit(tick(true, [], 1));
      expect(settled).toHaveBeenCalledOnce();
    });

    it('stops telling a listener once it unsubscribes', () => {
      const client = new InMemoryMEditClient();
      const settled = vi.fn();
      client.onLoadOrderSettled(settled)();

      client.emit(tick(true));

      expect(settled).not.toHaveBeenCalled();
    });
  });
});

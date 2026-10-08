import { describe, it, expect, vi } from 'vitest';
import type { NotificationEvent } from '../apiClient';
import type { PluginLoadFailure } from '../MEditClient';
import { InMemoryMEditClient } from './InMemoryMEditClient';

function tick(conflictsComputed: boolean, failures: PluginLoadFailure[] = []): NotificationEvent {
  return {
    kind: 'load-order-status', plugin: '', origin: '', keys: [], sequence: 0,
    loadOrderStatus: {
      state: 'Ready', totalPlugins: 0, activePlugins: 0, indexedPlugins: [], conflictsComputed, failures, version: 1,
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

  it('tells a listener, with the new status already readable, when conflictsComputed or the failures change, and when it resets', () => {
    const client = new InMemoryMEditClient();
    const seen: unknown[] = [];
    client.onLoadOrderStatusChanged(() => seen.push(client.loadOrderStatus?.failures.length ?? 'reset'));

    client.emit(tick(false, [bad]));
    client.emit(tick(true, [bad]));
    client.emit(tick(true));
    client.setStatus('disconnected');

    expect(seen).toEqual([1, 1, 0, 'reset']);
  });

  it('tells a listener nothing when a tick repeats the picture held, or when it resets with nothing held', () => {
    const client = new InMemoryMEditClient();
    const changed = vi.fn();
    client.onLoadOrderStatusChanged(changed);

    client.setStatus('disconnected');
    client.emit(tick(true, [bad]));
    client.emit(tick(true, [{ ...bad }]));

    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('stops telling a listener once it unsubscribes', () => {
    const client = new InMemoryMEditClient();
    const changed = vi.fn();
    client.onLoadOrderStatusChanged(changed)();

    client.emit(tick(true));

    expect(changed).not.toHaveBeenCalled();
  });
});

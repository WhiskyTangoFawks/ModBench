import { describe, it, expect, vi } from 'vitest';
import type { NotificationEvent, PluginLoadFailure } from '../../client';
import { InMemoryMEditClient } from '../../client';
import { trackLoadOrderStatus } from '../loadOrderStatusTracker';

function tick(conflictsComputed: boolean, failures: PluginLoadFailure[] = []): NotificationEvent {
  return {
    kind: 'load-order-status', plugin: '', origin: '', keys: [], sequence: 0,
    loadOrderStatus: {
      state: 'Ready', totalPlugins: 0, activePlugins: 0, indexedPlugins: [], conflictsComputed, failures, version: 1,
    },
  };
}

describe('trackLoadOrderStatus', () => {
  it('reads false before the first tick — not computed is never settled', () => {
    const client = new InMemoryMEditClient();
    const tracker = trackLoadOrderStatus(client);

    expect(tracker.current()).toBe(false);
  });

  it('reads the latest tick\'s own value', () => {
    const client = new InMemoryMEditClient();
    const tracker = trackLoadOrderStatus(client);

    client.emit(tick(true));
    expect(tracker.current()).toBe(true);

    client.emit(tick(false));
    expect(tracker.current()).toBe(false);
  });

  // The rival: a dispose that forgets to unsubscribe, so a tick emitted after disposal still
  // moves the tracker — exactly the leak that would keep a torn-down panel host live.
  it('stops updating once disposed', () => {
    const client = new InMemoryMEditClient();
    const tracker = trackLoadOrderStatus(client);
    client.emit(tick(true));

    tracker.dispose();
    client.emit(tick(false));

    expect(tracker.current()).toBe(true);
  });

  // ADR-0002: mEdit crashing and restarting starts a fresh reconcile, so a settled answer from the
  // old process must not outlive it — reconcileNarrator's own detached() resets on the same two
  // signals (toolbox.ts).
  it('resets to false when the backend leaves running, so a re-indexing process answers unsettled', () => {
    const client = new InMemoryMEditClient();
    const tracker = trackLoadOrderStatus(client);
    client.emit(tick(true));
    expect(tracker.current()).toBe(true);

    client.setStatus('disconnected');

    expect(tracker.current()).toBe(false);
  });

  it('resets to false on reconnect, since the stream may have reattached to another process', () => {
    const client = new InMemoryMEditClient();
    const tracker = trackLoadOrderStatus(client);
    client.emit(tick(true));
    expect(tracker.current()).toBe(true);

    client.reconnected();

    expect(tracker.current()).toBe(false);
  });

  it('reads the latest tick\'s load failures, and none before the first tick', () => {
    const client = new InMemoryMEditClient();
    const tracker = trackLoadOrderStatus(client);
    expect(tracker.failures()).toEqual([]);

    const bad = { name: 'Bad.esp', origin: 'Mod', reason: 'truncated' };
    client.emit(tick(false, [bad]));
    expect(tracker.failures()).toEqual([bad]);

    client.emit(tick(true));
    expect(tracker.failures()).toEqual([]);
  });

  it('forgets the failures when the backend leaves running or reconnects', () => {
    const client = new InMemoryMEditClient();
    const tracker = trackLoadOrderStatus(client);
    client.emit(tick(true, [{ name: 'Bad.esp', origin: 'Mod', reason: 'truncated' }]));

    client.setStatus('disconnected');
    expect(tracker.failures()).toEqual([]);

    client.emit(tick(true, [{ name: 'Bad.esp', origin: 'Mod', reason: 'truncated' }]));
    client.reconnected();
    expect(tracker.failures()).toEqual([]);
  });

  describe('onFailuresChanged', () => {
    const bad = { name: 'Bad.esp', origin: 'Mod', reason: 'truncated' };

    it('fires, with the new failures already readable, when a tick brings or clears a failure', () => {
      const client = new InMemoryMEditClient();
      const seen: unknown[] = [];
      const tracker = trackLoadOrderStatus(client, () => seen.push(tracker.failures()));

      client.emit(tick(false, [bad]));
      client.emit(tick(false));

      expect(seen).toEqual([[bad], []]);
    });

    it('stays silent on a tick whose failures are the ones already held', () => {
      const client = new InMemoryMEditClient();
      const onChanged = vi.fn();
      trackLoadOrderStatus(client, onChanged);

      client.emit(tick(false));
      client.emit(tick(false, [bad]));
      client.emit(tick(true, [{ ...bad }]));

      expect(onChanged).toHaveBeenCalledTimes(1);
    });
  });
});

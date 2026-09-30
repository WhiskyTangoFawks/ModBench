import { describe, it, expect } from 'vitest';
import type { NotificationEvent } from '../../client';
import { InMemoryMEditClient } from '../../client';
import { trackConflictsComputed } from '../conflictsComputedTracker';

function tick(conflictsComputed: boolean): NotificationEvent {
  return {
    kind: 'load-order-status', plugin: '', origin: '', keys: [], sequence: 0,
    loadOrderStatus: {
      state: 'Ready', totalPlugins: 0, indexedPlugins: [], conflictsComputed, failures: [], version: 1,
    },
  };
}

describe('trackConflictsComputed', () => {
  it('reads false before the first tick — not computed is never settled', () => {
    const client = new InMemoryMEditClient();
    const tracker = trackConflictsComputed(client);

    expect(tracker.current()).toBe(false);
  });

  it('reads the latest tick\'s own value', () => {
    const client = new InMemoryMEditClient();
    const tracker = trackConflictsComputed(client);

    client.emit(tick(true));
    expect(tracker.current()).toBe(true);

    client.emit(tick(false));
    expect(tracker.current()).toBe(false);
  });

  // The rival: a dispose that forgets to unsubscribe, so a tick emitted after disposal still
  // moves the tracker — exactly the leak that would keep a torn-down panel host live.
  it('stops updating once disposed', () => {
    const client = new InMemoryMEditClient();
    const tracker = trackConflictsComputed(client);
    client.emit(tick(true));

    tracker.dispose();
    client.emit(tick(false));

    expect(tracker.current()).toBe(true);
  });
});

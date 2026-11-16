import type { NotificationEvent } from '../apiClient';
import type { IndexOfPlugin } from '../MEditClient';
import { keepLoadOrderStatus } from '../loadOrderStatusKeeper';
import { SseNotificationSubscriber } from '../notificationStream';
import { keepRecordIndexChanges } from '../recordIndexChanges';
import { IGNORED_THROWS } from './fixtures';
import type { InMemoryMEditClient } from './InMemoryMEditClient';

/** The wire's frame, which a test names without reaching into the client. */
export type Frame = NotificationEvent;

const hubs = new WeakMap<InMemoryMEditClient, SseNotificationSubscriber>();

function hubOf(client: InMemoryMEditClient): SseNotificationSubscriber {
  const held = hubs.get(client);
  if (held) return held;
  const hub = new SseNotificationSubscriber({ listenerThrows: IGNORED_THROWS, openStream: () => Promise.reject(new Error('never started')) });
  const standing = keepLoadOrderStatus({
    onNotification: (kind, listener) => hub.onNotification(kind, listener),
    onStatusChanged: (listener) => client.onStatusChanged(listener),
    onReconnected: (listener) => client.onReconnected(listener),
  });
  standing.onStatus((status) => {
    client.setProgress(standing.progress());
    const indexing: IndexOfPlugin[] = [
      ...(status?.indexedPlugins ?? []).map(({ name, origin }): IndexOfPlugin => ({ name, origin, state: 'Indexed', changedOutside: false })),
      ...(status?.failures ?? []).map(({ name, origin, reason, diagnosis }): IndexOfPlugin => ({ name, origin, state: 'Failed', reason, diagnosis, changedOutside: false })),
    ];
    client.setQueryAnswer('getPluginsIndexing', indexing);
  });
  keepRecordIndexChanges({
    onNotification: (kind, listener) => hub.onNotification(kind, listener),
    onStatusChanged: () => () => undefined,
    onReconnected: () => () => undefined,
  }, standing).onDidChange((change) => { client.change(change); });
  hubs.set(client, hub);
  return hub;
}

/** A notification frame as the wire carries it, told to the double as the client would tell it: what it names on the change
 *  event, how far the record index has come, and the index state of each plugin. */
export function fire(client: InMemoryMEditClient, event: NotificationEvent): void {
  hubOf(client).dispatch(event);
  client.hearSequence(event.sequence);
}

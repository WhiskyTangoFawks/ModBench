import type { NotificationEvent } from '../apiClient';
import type { BackendStatus, NotificationKind, NotificationPayloads } from '../MEditClient';
import { keepLoadOrderStatus } from '../loadOrderStatusKeeper';
import { SseNotificationSubscriber } from '../notificationStream';
import { keepRecordIndexChanges } from '../recordIndexChanges';
import { IGNORED_THROWS } from './fixtures';

/** What the client's keepers are given by its stream and its process, and what they keep from them. */
export function keepers() {
  const stream = new SseNotificationSubscriber({ listenerThrows: IGNORED_THROWS, openStream: () => Promise.reject(new Error('never started')) });
  const statusListeners = new Set<(status: BackendStatus) => void>();
  const reconnectListeners = new Set<() => void>();
  const source = {
    onNotification: <K extends NotificationKind>(kind: K, listener: (payload: NotificationPayloads[K]) => void) => stream.onNotification(kind, listener),
    onStatusChanged: (listener: (status: BackendStatus) => void) => { statusListeners.add(listener); return () => { statusListeners.delete(listener); }; },
    onReconnected: (listener: () => void) => { reconnectListeners.add(listener); return () => { reconnectListeners.delete(listener); }; },
  };
  const standing = keepLoadOrderStatus(source);
  const changes = keepRecordIndexChanges(source, standing);
  return {
    standing,
    onDidChange: (listener: Parameters<typeof changes.onDidChange>[0]) => changes.onDidChange(listener),
    fire: (event: NotificationEvent) => { stream.dispatch(event); },
    setStatus: (status: BackendStatus) => { for (const listener of [...statusListeners]) listener(status); },
    reconnected: () => { for (const listener of [...reconnectListeners]) listener(); },
  };
}

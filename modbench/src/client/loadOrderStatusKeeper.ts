import type { LoadOrderStatus } from './apiClient';
import { isSettled } from './apiClient';
import type { NotificationSource } from './notificationStream';
import { isMEditGone, type MEditClient, type RecordIndexProgress } from './MEditClient';

export interface LoadOrderStatusKeeper {
  current(): LoadOrderStatus | undefined;
  /** The plugins done out of the load order's, while the record index indexes it. */
  progress(): RecordIndexProgress | undefined;
  onStatus(listener: (status: LoadOrderStatus | undefined) => void): () => void;
  onChanged(listener: (status: LoadOrderStatus) => void): () => void;
}

export function keepLoadOrderStatus(
  client: NotificationSource & Pick<MEditClient, 'onStatusChanged'> & { onReconnected(listener: () => void): () => void },
): LoadOrderStatusKeeper {
  let latest: LoadOrderStatus | undefined;
  let settledVersion = -1;
  const statusListeners = new Set<(status: LoadOrderStatus | undefined) => void>();
  const changedListeners = new Set<(status: LoadOrderStatus) => void>();
  const tell = <T>(listeners: Set<(value: T) => void>, value: T) => { for (const listener of listeners) listener(value); };

  const hear = (status: LoadOrderStatus) => {
    const failuresChanged = JSON.stringify(status.failures) !== JSON.stringify(latest?.failures ?? []);
    const droppedOrRestored = status.holdsNone !== (latest?.holdsNone ?? false);
    const refusalChanged = JSON.stringify(status.refusal) !== JSON.stringify(latest?.refusal);
    // A refresh reconciles the version already settled again.
    const reconciled = status.conflictsComputed && (status.version > settledVersion || latest?.conflictsComputed === false);
    latest = status;
    tell(statusListeners, status);
    if (reconciled) settledVersion = status.version;
    if (reconciled || failuresChanged || refusalChanged || droppedOrRestored) tell(changedListeners, status);
  };
  const reset = () => {
    latest = undefined;
    settledVersion = -1;
    tell(statusListeners, undefined);
  };
  client.onNotification('load-order-status', hear);
  client.onStatusChanged((status) => { if (isMEditGone(status)) reset(); });
  client.onReconnected(reset);
  return {
    current: () => latest,
    progress: () => {
      if (latest === undefined || latest.holdsNone || isSettled(latest)) return undefined;
      return { done: latest.indexedPlugins.length + latest.failures.length, total: latest.totalPlugins };
    },
    onStatus: (listener) => { statusListeners.add(listener); return () => { statusListeners.delete(listener); }; },
    onChanged: (listener) => { changedListeners.add(listener); return () => { changedListeners.delete(listener); }; },
  };
}

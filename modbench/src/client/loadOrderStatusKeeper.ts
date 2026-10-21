import type { LoadOrderStatus } from './apiClient';
import { isMEditGone, type MEditClient } from './MEditClient';

export interface LoadOrderStatusKeeper {
  current(): LoadOrderStatus | undefined;
  onStatus(listener: (status: LoadOrderStatus | undefined) => void): () => void;
  onSettled(listener: (status: LoadOrderStatus) => void): () => void;
}

export function keepLoadOrderStatus(
  client: Pick<MEditClient, 'onNotification' | 'onStatusChanged' | 'onReconnected'>,
): LoadOrderStatusKeeper {
  let latest: LoadOrderStatus | undefined;
  let settledVersion = -1;
  const statusListeners = new Set<(status: LoadOrderStatus | undefined) => void>();
  const settledListeners = new Set<(status: LoadOrderStatus) => void>();
  const tell = <T>(listeners: Set<(value: T) => void>, value: T) => { for (const listener of listeners) listener(value); };

  const hear = (status: LoadOrderStatus) => {
    const failuresChanged = JSON.stringify(status.failures) !== JSON.stringify(latest?.failures ?? []);
    latest = status;
    tell(statusListeners, status);
    const reconciled = status.conflictsComputed && status.version > settledVersion;
    if (reconciled) settledVersion = status.version;
    if (reconciled || failuresChanged) tell(settledListeners, status);
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
    onStatus: (listener) => { statusListeners.add(listener); return () => { statusListeners.delete(listener); }; },
    onSettled: (listener) => { settledListeners.add(listener); return () => { settledListeners.delete(listener); }; },
  };
}

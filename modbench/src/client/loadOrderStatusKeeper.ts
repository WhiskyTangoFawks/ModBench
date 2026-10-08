import type { LoadOrderStatus } from './apiClient';
import { isMEditGone, type MEditClient } from './MEditClient';

export interface LoadOrderStatusKeeper {
  current(): LoadOrderStatus | undefined;
  onChanged(listener: (status: LoadOrderStatus | undefined) => void): () => void;
}

const settledPicture = ({ conflictsComputed, failures }: LoadOrderStatus) => JSON.stringify({ conflictsComputed, failures });

export function keepLoadOrderStatus(
  client: Pick<MEditClient, 'onNotification' | 'onStatusChanged' | 'onReconnected'>,
): LoadOrderStatusKeeper {
  let latest: LoadOrderStatus | undefined;
  const listeners = new Set<(status: LoadOrderStatus | undefined) => void>();
  const take = (next: LoadOrderStatus | undefined) => {
    const changed = (next && settledPicture(next)) !== (latest && settledPicture(latest));
    latest = next;
    if (changed) for (const listener of [...listeners]) listener(next);
  };
  client.onNotification('load-order-status', take);
  client.onStatusChanged((status) => { if (isMEditGone(status)) take(undefined); });
  client.onReconnected(() => { take(undefined); });
  return {
    current: () => latest,
    onChanged: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

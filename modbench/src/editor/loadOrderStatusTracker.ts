import type { MEditClient, PluginLoadFailure } from '../client';

/** The load-order status's latest answer, kept live off the notification stream. Before the first
 *  tick, `current` reads false (never "settled") and `failures` is empty. */
export interface LoadOrderStatusTracker {
  current(): boolean;
  failures(): readonly PluginLoadFailure[];
  dispose(): void;
}

export function trackLoadOrderStatus(
  client: Pick<MEditClient, 'subscribe' | 'onStatusChanged' | 'onReconnected'>,
  onFailuresChanged: () => void = () => undefined,
): LoadOrderStatusTracker {
  let value = false;
  let failures: readonly PluginLoadFailure[] = [];
  const forget = () => { value = false; failures = []; };
  const unsubscribeStatus = client.subscribe('load-order-status', (event) => {
    if (!event.loadOrderStatus) return;
    value = event.loadOrderStatus.conflictsComputed;
    const arrived = event.loadOrderStatus.failures;
    if (JSON.stringify(arrived) === JSON.stringify(failures)) return;
    failures = arrived;
    onFailuresChanged();
  });
  // Mirrors reconcileNarrator's own detached() reset, on the same two signals (toolbox.ts): a
  // crash-and-restart or a reattached stream starts the next process's reconcile from unsettled.
  const unsubscribeStatusChanged = client.onStatusChanged((status) => { if (status !== 'running') forget(); });
  const unsubscribeReconnected = client.onReconnected(forget);
  return {
    current: () => value,
    failures: () => failures,
    dispose: () => { unsubscribeStatus(); unsubscribeStatusChanged(); unsubscribeReconnected(); },
  };
}

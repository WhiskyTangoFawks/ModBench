import { isMEditGone, type MEditClient, type PluginLoadFailure } from '../client';

/** The load-order status's latest answer, kept live off the notification stream. Before the first
 *  tick, `current` reads false (never "settled") and `failures` is empty. */
export interface LoadOrderStatusTracker {
  current(): boolean;
  failures(): readonly PluginLoadFailure[];
  dispose(): void;
}

export function trackLoadOrderStatus(
  client: Pick<MEditClient, 'onNotification' | 'onStatusChanged' | 'onReconnected'>,
  onFailuresChanged: () => void = () => undefined,
  onCurrentChanged: () => void = () => undefined,
): LoadOrderStatusTracker {
  let value = false;
  let failures: readonly PluginLoadFailure[] = [];
  const settle = (next: boolean) => {
    if (next === value) return;
    value = next;
    onCurrentChanged();
  };
  const forget = () => { settle(false); failures = []; };
  const unsubscribeStatus = client.onNotification('load-order-status', (status) => {
    settle(status.conflictsComputed);
    const arrived = status.failures;
    if (JSON.stringify(arrived) === JSON.stringify(failures)) return;
    failures = arrived;
    onFailuresChanged();
  });
  // Mirrors reconcileNarrator's own detached() reset, on the same two signals
  // (plugins/indexStatus.ts): a crash-and-restart or a reattached stream starts the next process's
  // reconcile from unsettled.
  const unsubscribeStatusChanged = client.onStatusChanged((status) => { if (isMEditGone(status)) forget(); });
  const unsubscribeReconnected = client.onReconnected(forget);
  return {
    current: () => value,
    failures: () => failures,
    dispose: () => { unsubscribeStatus(); unsubscribeStatusChanged(); unsubscribeReconnected(); },
  };
}

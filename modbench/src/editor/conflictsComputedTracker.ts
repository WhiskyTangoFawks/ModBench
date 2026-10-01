import type { MEditClient } from '../client';

/** The load-order sweep's latest known answer, kept live off the notification stream rather than
 *  polled. Reads false until the first tick, never mistaking "not computed" for "settled". */
export interface ConflictsComputedTracker {
  current(): boolean;
  dispose(): void;
}

export function trackConflictsComputed(
  client: Pick<MEditClient, 'subscribe' | 'onStatusChanged' | 'onReconnected'>,
): ConflictsComputedTracker {
  let value = false;
  const unsubscribeStatus = client.subscribe('load-order-status', (event) => {
    if (event.loadOrderStatus) value = event.loadOrderStatus.conflictsComputed;
  });
  // Mirrors reconcileNarrator's own detached() reset, on the same two signals (toolbox.ts): a
  // crash-and-restart or a reattached stream starts the next process's reconcile from unsettled.
  const unsubscribeStatusChanged = client.onStatusChanged((status) => { if (status !== 'running') value = false; });
  const unsubscribeReconnected = client.onReconnected(() => { value = false; });
  return {
    current: () => value,
    dispose: () => { unsubscribeStatus(); unsubscribeStatusChanged(); unsubscribeReconnected(); },
  };
}

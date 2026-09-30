import type { MEditClient } from '../client';

/** The load-order sweep's latest known answer, kept live off the notification stream rather than
 *  polled. Reads false until the first tick, never mistaking "not computed" for "settled". */
export interface ConflictsComputedTracker {
  current(): boolean;
  dispose(): void;
}

export function trackConflictsComputed(client: Pick<MEditClient, 'subscribe'>): ConflictsComputedTracker {
  let value = false;
  const unsubscribe = client.subscribe('load-order-status', (event) => {
    if (event.loadOrderStatus) value = event.loadOrderStatus.conflictsComputed;
  });
  return { current: () => value, dispose: unsubscribe };
}

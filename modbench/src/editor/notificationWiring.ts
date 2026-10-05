import type { MEditClient } from '../client';

// On reconnect, a panel waiting on a missed report reads once mEdit holds it.
export function subscribeRecordPanelsToNotifications<Panel>(
  client: Pick<MEditClient, 'onNotification' | 'onReconnected' | 'getRecordOwner'>,
  recordPanels: Set<Panel>,
  reads: {
    reported(panel: Panel, keys: readonly string[]): void;
    waitingFor(panel: Panel): string | undefined;
    release(panel: Panel, formKey: string): void;
  },
): () => void {
  const unsubscribeRows = client.onNotification('rows-changed', (event) => {
    for (const panel of recordPanels) reads.reported(panel, event.keys);
  });
  const unsubscribeReconnect = client.onReconnected(() => {
    for (const panel of recordPanels) {
      const formKey = reads.waitingFor(panel);
      if (!formKey) continue;
      // A failed ask leaves the panel waiting, as a missing key does: the report still reads it.
      client.getRecordOwner(formKey).then(
        owner => { if (owner) reads.release(panel, formKey); },
        () => undefined);
    }
  });
  return () => { unsubscribeRows(); unsubscribeReconnect(); };
}

/** A completed reconcile or a landed Track: every record panel reads its comparison again. */
export function announceConflictsComputed<Panel>(
  recordPanels: Set<Panel>,
  reads: { refresh(panel: Panel): void },
): void {
  for (const panel of recordPanels) reads.refresh(panel);
}

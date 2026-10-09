import type { MEditClient } from '../client';
import type { RecordTab } from './recordTab';
import { isReadFailed } from '../wire/readFailed';

// On reconnect, a tab waiting on a missed report reads once mEdit holds it.
export function subscribeRecordTabsToNotifications(
  client: Pick<MEditClient, 'onNotification' | 'onReconnected' | 'getRecordOwner'>,
  tabs: Iterable<RecordTab>,
): () => void {
  const unsubscribeRows = client.onNotification('rows-changed', (event) => {
    for (const tab of tabs) tab.reported(event.keys);
  });
  const unsubscribeReconnect = client.onReconnected(() => {
    for (const tab of tabs) {
      const formKey = tab.waitingFor();
      if (!formKey) continue;
      // A failed ask leaves the tab waiting, as a missing key does: the report still reads it.
      client.getRecordOwner(formKey).then(
        owner => { if (owner && !isReadFailed(owner)) tab.release(formKey); },
        () => undefined);
    }
  });
  return () => { unsubscribeRows(); unsubscribeReconnect(); };
}

/** A reconcile settled: every record tab reads its comparison again. */
export function announceConflictsComputed(tabs: Iterable<RecordTab>): void {
  for (const tab of tabs) tab.refresh();
}

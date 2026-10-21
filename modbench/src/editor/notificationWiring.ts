import type { MEditClient } from '../client';
import type { RecordTab } from './recordTab';
import { isReadFailed } from '../wire/readFailed';

// A plugin re-derived whole is announced with no keys (ADR-0015): a tab waiting on a report reads once mEdit holds its record.
export function subscribeRecordTabsToNotifications(
  client: Pick<MEditClient, 'onNotification' | 'getRecordOwner'>,
  tabs: Iterable<RecordTab>,
): () => void {
  const unsubscribeRows = client.onNotification('rows-changed', (event) => {
    for (const tab of tabs) tab.reported(event.keys);
  });
  const unsubscribePlugin = client.onNotification('plugin-changed', () => {
    for (const tab of tabs) {
      const formKey = tab.waitingFor();
      if (!formKey) continue;
      // A failed ask leaves the tab waiting, as a missing key does: the report still reads it.
      client.getRecordOwner(formKey).then(
        owner => { if (owner && !isReadFailed(owner)) tab.release(formKey); },
        () => undefined);
    }
  });
  return () => { unsubscribeRows(); unsubscribePlugin(); };
}

/** A reconcile settled: every record tab reads its comparison again. */
export function announceConflictsComputed(tabs: Iterable<RecordTab>): void {
  for (const tab of tabs) tab.refresh();
}

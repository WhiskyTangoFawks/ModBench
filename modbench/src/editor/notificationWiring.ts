import type { MEditClient } from '../client';
import type { RecordTab } from './recordTab';
import { isReadFailed } from '../wire/readFailed';

// A plugin re-derived whole is announced with no keys: a tab waiting on a report reads once mEdit holds its record.
export function subscribeRecordTabsToNotifications(
  client: Pick<MEditClient, 'onDidChange' | 'getRecordOwners'>,
  tabs: Iterable<RecordTab>,
): () => void {
  const subscription = client.onDidChange((change) => {
    for (const { keys } of change ?? []) if (keys) for (const tab of tabs) tab.reported(keys);
    if (change !== undefined && change.every(({ keys }) => keys !== undefined)) return;
    for (const tab of tabs) {
      const formKey = tab.waitingFor();
      if (!formKey) continue;
      // A failed ask leaves the tab waiting, as a missing key does: the report still reads it.
      client.getRecordOwners(formKey).then(
        owners => { if (!isReadFailed(owners) && owners.length > 0) tab.release(formKey); },
        () => undefined);
    }
  });
  return () => { subscription.dispose(); };
}

/** A reconcile settled: every record tab reads its comparison again. */
export function announceConflictsComputed(tabs: Iterable<RecordTab>): void {
  for (const tab of tabs) tab.refresh();
}

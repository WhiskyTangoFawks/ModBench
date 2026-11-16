import type { MEditClient } from '../client';
import type { RecordTab } from './recordTab';
import { isReadFailed } from '../wire/readFailed';

// A plugin named with no keys is every record of it. A tab waiting on a report reads once mEdit holds its record.
export function subscribeRecordTabsToNotifications(
  client: Pick<MEditClient, 'onDidChange' | 'onDidChangeRecordIndexMayBeLate' | 'getRecordOwners'>,
  tabs: Iterable<RecordTab>,
): () => void {
  const subscription = client.onDidChange((change) => {
    if (change === undefined) for (const tab of tabs) tab.askWhichRecordAgain();
    if (change === undefined || change.some(({ keys }) => keys === undefined)) for (const tab of tabs) tab.refresh();
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
  const lateness = client.onDidChangeRecordIndexMayBeLate((late) => {
    if (!late) for (const tab of tabs) tab.indexSettled();
  });
  return () => { subscription.dispose(); lateness.dispose(); };
}

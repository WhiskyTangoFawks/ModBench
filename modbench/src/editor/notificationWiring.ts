import type { MEditClient } from '../client';
import type { RecordTab } from './recordTab';
import { isReadFailed } from '../wire/readFailed';

// A plugin named with no keys is every record of it. A tab waiting on a report reads once mEdit holds its record.
export function subscribeRecordTabsToNotifications(
  client: Pick<MEditClient, 'onDidChange' | 'getRecordOwners' | 'loadOrderStatus'>,
  tabs: Iterable<RecordTab>,
): () => void {
  const subscription = client.onDidChange((change) => {
    if (change === undefined) for (const tab of tabs) tab.askWhichRecordAgain();
    // A read before mEdit holds a load order fails: the status that follows the reset settles, and reads then.
    if (client.loadOrderStatus !== undefined && (change === undefined || change.some(({ keys }) => keys === undefined))) {
      for (const tab of tabs) tab.refresh();
    }
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

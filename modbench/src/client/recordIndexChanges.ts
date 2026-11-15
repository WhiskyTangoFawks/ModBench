import type { MEditClient, RecordIndexChange } from './MEditClient';
import { EventEmitter, type Disposable } from './eventEmitter';
import type { LoadOrderStatusKeeper } from './loadOrderStatusKeeper';

export interface RecordIndexChanges {
  onDidChange(listener: (change: RecordIndexChange) => void): Disposable;
}

export function keepRecordIndexChanges(
  client: Pick<MEditClient, 'onNotification' | 'onStatusChanged'> & { onReconnected(listener: () => void): () => void },
  loadOrder: Pick<LoadOrderStatusKeeper, 'onSettled'>,
): RecordIndexChanges {
  const changes = new EventEmitter<RecordIndexChange>();
  const tell = (change: RecordIndexChange) => { changes.fire(change); };

  client.onNotification('rows-changed', ({ plugin, keys }) => { tell([{ plugin, keys }]); });
  client.onNotification('plugin-changed', ({ plugin }) => { tell([{ plugin }]); });
  client.onNotification('record-filter-cleared', () => { tell(undefined); });
  loadOrder.onSettled(() => { tell(undefined); });
  client.onReconnected(() => { tell(undefined); });
  client.onStatusChanged((status) => { if (status === 'running') tell(undefined); });

  return { onDidChange: changes.event };
}

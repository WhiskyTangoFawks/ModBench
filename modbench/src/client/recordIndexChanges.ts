import { isMEditGone, type MEditClient, type RecordIndexChange } from './MEditClient';
import { EventEmitter, type Disposable } from './eventEmitter';
import type { LoadOrderStatusKeeper } from './loadOrderStatusKeeper';

export interface RecordIndexChanges {
  onDidChange(listener: (change: RecordIndexChange) => void): Disposable;
}

export function keepRecordIndexChanges(
  client: Pick<MEditClient, 'onNotification' | 'onStatusChanged'> & { onReconnected(listener: () => void): () => void },
  loadOrder: Pick<LoadOrderStatusKeeper, 'onSettled'>,
): RecordIndexChanges {
  const changes = new EventEmitter<[RecordIndexChange]>();
  const tell = (change: RecordIndexChange) => { changes.fire(change); };

  client.onNotification('rows-changed', ({ plugin, keys }) => { tell([{ plugin, keys }]); });
  client.onNotification('plugin-changed', ({ plugin }) => { tell([{ plugin }]); });
  loadOrder.onSettled(() => { tell(undefined); });
  client.onReconnected(() => { tell(undefined); });
  let ran = false;
  let gone = false;
  client.onStatusChanged((status) => {
    if (isMEditGone(status)) { gone = true; return; }
    if (status !== 'running') return;
    if (ran && gone) tell(undefined);
    ran = true;
    gone = false;
  });

  return { onDidChange: changes.event };
}

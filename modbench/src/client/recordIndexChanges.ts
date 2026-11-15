import { isMEditGone, type MEditClient, type RecordIndexChange } from './MEditClient';
import type { LoadOrderStatusKeeper } from './loadOrderStatusKeeper';

export interface RecordIndexChanges {
  onDidChange(listener: (change: RecordIndexChange) => void): { dispose(): void };
}

/** The one change event: the plugins and keys the stream names, and everything when a load order
 *  settles, the stream reopens, or mEdit runs again after it went. */
export function keepRecordIndexChanges(
  client: Pick<MEditClient, 'onNotification' | 'onStatusChanged'> & { onReconnected(listener: () => void): () => void },
  loadOrder: Pick<LoadOrderStatusKeeper, 'onSettled'>,
): RecordIndexChanges {
  const listeners = new Set<(change: RecordIndexChange) => void>();
  const tell = (change: RecordIndexChange) => { for (const listener of [...listeners]) listener(change); };

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

  return {
    onDidChange: (listener) => {
      listeners.add(listener);
      return { dispose: () => { listeners.delete(listener); } };
    },
  };
}

import type * as vscode from 'vscode';
import type { MEditClient } from './client';
import type { Instance, InstanceValue } from './instanceLoader/instance';
import { errorMessage } from './ports/errorMessage';

export interface LoadOrderPuts extends vscode.Disposable {
  /** The put that follows a connect, sent whatever the backend before it had: the backend just
   *  attached holds no load order. Until it runs, no recompute puts. */
  putOnConnect(): Promise<void>;
}

// update-load-order-file: the load order is put on change and on connect. A value that lands
// while mEdit is detached is not put, because the connect's own put reads the value current then.
export function registerLoadOrderPut(
  instance: Pick<Instance, 'subscribe'>,
  client: Pick<MEditClient, 'onStatusChanged'>,
  changed: (value: InstanceValue) => boolean,
  put: () => Promise<void>,
  channel: { error(msg: string): void },
): LoadOrderPuts {
  let connected = false;
  const unsubscribeStatus = client.onStatusChanged((status) => {
    if (status !== 'attached') connected = false;
  });
  const subscription = instance.subscribe((value) => {
    if (!connected || !changed(value)) return;
    void put().catch((e: unknown) => channel.error(`[toolbox] handing mEdit the load order threw: ${errorMessage(e)}`));
  });
  return {
    putOnConnect: () => {
      connected = true;
      return put();
    },
    dispose: () => {
      unsubscribeStatus();
      subscription.dispose();
    },
  };
}

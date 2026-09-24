import type * as vscode from 'vscode';
import type { Instance, InstanceValue } from './instanceLoader/instance';
import { errorMessage } from './ports/errorMessage';

// Stated structurally: contextBoundary.test.ts refuses an import of the mEdit client from any file
// outside its COMPOSITION_ROOT list, and this trigger only hears the client, never calls it.
interface ClientConnection {
  onStatusChanged(listener: (status: 'starting' | 'attached' | 'disconnected' | 'stopped') => void): () => void;
  onReconnected(listener: () => void): () => void;
}

export interface LoadOrderPuts extends vscode.Disposable {
  /** The put that follows a connect, sent whatever the backend before it had: the backend just
   *  attached holds no load order. Until it runs, no recompute puts. */
  putOnConnect(): Promise<void>;
}

// update-load-order-file: put on change and on connect. Nothing is put while detached, since the
// connect's put reads the value current then; a stream reopen is a connect, the process behind it
// perhaps another.
export function registerLoadOrderPut(
  instance: Pick<Instance, 'subscribe'>,
  client: ClientConnection,
  changed: (value: InstanceValue) => boolean,
  put: () => Promise<void>,
  channel: { error(msg: string): void },
): LoadOrderPuts {
  let connectPutRan = false;
  const putLogged = (): void => {
    void put().catch((e: unknown) => channel.error(`[loadOrder] handing mEdit the load order threw: ${errorMessage(e)}`));
  };
  const unsubscribeStatus = client.onStatusChanged((status) => {
    if (status !== 'attached') connectPutRan = false;
  });
  // Deferred past the other reopen listeners, the sender's forgetting what it sent among them.
  const unsubscribeReopen = client.onReconnected(() => {
    void Promise.resolve().then(() => { if (connectPutRan) putLogged(); });
  });
  const subscription = instance.subscribe((value) => {
    if (connectPutRan && changed(value)) putLogged();
  });
  return {
    putOnConnect: () => {
      connectPutRan = true;
      return put();
    },
    dispose: () => {
      unsubscribeStatus();
      unsubscribeReopen();
      subscription.dispose();
    },
  };
}

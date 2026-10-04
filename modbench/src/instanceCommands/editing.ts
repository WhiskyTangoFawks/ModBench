// Entering editing and put load order (ADR-0013). Nothing is put while detached; a stream reopen
// is a start, the process behind it perhaps another. What happened comes back through `tell`.

import type { LoadOrderSender, MEditClient } from '../client';
import { enterEditingAcrossRestarts } from '../client';
import { errorMessage } from '../ports/errorMessage';
import { putLoadOrder, type LoadOrderSource, type PutLoadOrderResult } from './loadOrder';

export type Told =
  | { kind: 'put'; put: PutLoadOrderResult }
  | { kind: 'putThrew'; message: string }
  | { kind: 'abandoned' }
  | { kind: 'backendFailed' };

export interface EditingDeps {
  client: Pick<MEditClient, 'status' | 'start' | 'onStatusChanged' | 'onReconnected'>;
  sender: Pick<LoadOrderSender, 'arm' | 'send'>;
  instanceRoot: string;
  /** The instance value once its first read has landed. */
  landed: () => Promise<LoadOrderSource>;
  exitEditing: () => void;
  around: (entry: () => Promise<void>) => Promise<void>;
  tell: (told: Told) => Promise<void>;
  log: (message: string) => void;
}

export interface EditingFlow {
  enter(): Promise<void>;
  put(source: LoadOrderSource): Promise<void>;
  onRecompute(source: LoadOrderSource): void;
  dispose(): void;
}

export function editingFlow(deps: EditingDeps): EditingFlow {
  const { client, sender, instanceRoot, landed, exitEditing, around, tell, log } = deps;
  let startPutRan = false;

  const put = async (source: LoadOrderSource): Promise<void> => {
    await tell({ kind: 'put', put: await putLoadOrder(sender, instanceRoot, source) });
  };

  const putTold = (source: LoadOrderSource): void => {
    void put(source).catch((e: unknown) => tell({ kind: 'putThrew', message: errorMessage(e) }));
  };

  const enterOnce = async (): Promise<void> => {
    const { abandoned } = sender.arm();
    const source = landed();
    await client.start();
    // A close stops the backend, so an abandoned launch would fail the status gate below and
    // report the stop it asked for as a startup failure.
    if (abandoned()) return tell({ kind: 'abandoned' });
    if (client.status !== 'running') {
      exitEditing();
      return tell({ kind: 'backendFailed' });
    }
    const value = await source;
    if (!value.loadOrderSnapshot) return exitEditing();
    startPutRan = true;
    await put(value);
  };

  const statusSubscription = client.onStatusChanged((status) => {
    if (status !== 'running') startPutRan = false;
  });
  const reconnectSubscription = client.onReconnected(() => {
    if (startPutRan) void landed().then(putTold);
  });
  const entry = enterEditingAcrossRestarts(
    client, () => around(enterOnce), (message) => log(`[instanceCommands] ${message}`));

  return {
    enter: entry.enter,
    put,
    onRecompute: (source) => { if (startPutRan) putTold(source); },
    dispose: () => {
      statusSubscription();
      reconnectSubscription();
      entry.dispose();
      startPutRan = false;
    },
  };
}

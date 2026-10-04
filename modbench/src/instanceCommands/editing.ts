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
  exitEditing: () => void;
  around: (entry: () => Promise<void>) => Promise<void>;
  tell: (told: Told) => Promise<void>;
  log: (message: string) => void;
}

export interface EditingFlow {
  /** The source arrives as a promise so the backend starts while the first read lands. */
  enter(source: Promise<LoadOrderSource>): Promise<void>;
  put(source: LoadOrderSource): Promise<void>;
  onRecompute(source: LoadOrderSource): void;
  dispose(): void;
}

export function editingFlow(deps: EditingDeps): EditingFlow {
  const { client, sender, instanceRoot, exitEditing, around, tell, log } = deps;
  let startPutRan = false;
  let held: Promise<LoadOrderSource> | undefined;

  const put = async (source: LoadOrderSource): Promise<void> => {
    await tell({ kind: 'put', put: await putLoadOrder(sender, instanceRoot, source) });
  };

  const putHeld = (): void => {
    void held?.then(put).catch((e: unknown) => tell({ kind: 'putThrew', message: errorMessage(e) }));
  };

  const enterOnce = async (): Promise<void> => {
    const { abandoned } = sender.arm();
    const source = held;
    await client.start();
    // A close stops the backend, so an abandoned launch would fail the status gate below and
    // report the stop it asked for as a startup failure.
    if (abandoned()) return tell({ kind: 'abandoned' });
    if (client.status !== 'running') {
      exitEditing();
      return tell({ kind: 'backendFailed' });
    }
    const value = await source;
    if (!value?.loadOrderSnapshot) return exitEditing();
    startPutRan = true;
    await put(value);
  };

  const statusSubscription = client.onStatusChanged((status) => {
    if (status !== 'running') startPutRan = false;
  });
  const reconnectSubscription = client.onReconnected(() => {
    if (startPutRan) putHeld();
  });
  const entry = enterEditingAcrossRestarts(
    client, () => around(enterOnce), (message) => log(`[instanceCommands] ${message}`));

  return {
    enter: (source) => {
      held = source;
      return entry.enter();
    },
    put,
    onRecompute: (source) => {
      held = Promise.resolve(source);
      if (startPutRan) putHeld();
    },
    dispose: () => {
      statusSubscription();
      reconnectSubscription();
      entry.dispose();
      startPutRan = false;
    },
  };
}

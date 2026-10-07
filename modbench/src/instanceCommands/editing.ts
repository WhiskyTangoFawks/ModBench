// Put load order (ADR-0013) at every recompute. The client owns the process the snapshot goes to;
// what came of each put comes back through `tell`.

import type { LoadOrderOutcome, LoadOrderSnapshot, MEditClient } from '../client';
import { errorMessage } from '../ports/errorMessage';
import { putLoadOrder, type LoadOrderSource, type PutLoadOrderResult } from './loadOrder';

export type Told =
  | { kind: 'put'; put: PutLoadOrderResult }
  | { kind: 'putThrew'; message: string }
  | { kind: 'abandoned' }
  | { kind: 'backendFailed' };

export interface EditingDeps {
  client: Pick<MEditClient, 'sendLoadOrder' | 'onLoadOrderResent'>;
  instanceRoot: string;
  around: (entry: () => Promise<void>) => Promise<void>;
  tell: (told: Told) => Promise<void>;
}

export interface EditingFlow {
  /** Shown until the first read settles and the value it landed, if any, is told. */
  enter(firstRead: Promise<unknown>): Promise<void>;
  onRecompute(source: LoadOrderSource): void;
  dispose(): void;
}

function toldOf(put: PutLoadOrderResult): Told {
  return put.sent && put.outcome.outcome === 'backendFailed' ? { kind: 'backendFailed' } : { kind: 'put', put };
}

export function editingFlow(deps: EditingDeps): EditingFlow {
  const { client, instanceRoot, around, tell } = deps;
  let lastTold = Promise.resolve();

  const tellPut = (put: Promise<PutLoadOrderResult>): void => {
    lastTold = put
      .then((result) => tell(toldOf(result)))
      .catch((e: unknown) => tell({ kind: 'putThrew', message: errorMessage(e) }));
  };

  const resent = (snapshot: LoadOrderSnapshot, outcome: LoadOrderOutcome): void => {
    tellPut(Promise.resolve({ sent: true, snapshot, outcome }));
  };
  const unsubscribe = client.onLoadOrderResent(resent);

  return {
    // A landed read reached `onRecompute` before `firstRead` settles, so `lastTold` is its put.
    enter: (firstRead) => around(async () => {
      await firstRead;
      await lastTold;
    }),
    onRecompute: (source) => { tellPut(putLoadOrder(client, instanceRoot, source)); },
    dispose: unsubscribe,
  };
}

// Put load order (ADR-0013) at every recompute. The client owns the process the snapshot goes to;
// what came of each put, and of each launch, comes back through `tell`.

import type { LaunchOutcome, LoadOrderOutcome, LoadOrderSnapshot, MEditClient } from '../client';
import { errorMessage } from '../ports/errorMessage';
import { putLoadOrder, type LoadOrderSource, type PutLoadOrderResult } from './loadOrder';

export type Told =
  | { kind: 'put'; put: PutLoadOrderResult }
  | { kind: 'launchFailed'; reason: string }
  | { kind: 'backendFailed' };

export interface EditingDeps {
  client: Pick<MEditClient, 'sendLoadOrder' | 'onLoadOrderResent' | 'onLaunch' | 'latestLoadOrder'>;
  instanceRoot: string;
  /** Shows a launch, from its start until the snapshot it was for is told (plugins.md, States 2). */
  around: (entry: () => Promise<void>) => Promise<void>;
  tell: (told: Told) => Promise<void>;
  /** The Output, for a tell that threw: no caller is left to hear it. */
  log: (line: string) => void;
}

export interface EditingFlow {
  /** The launch with the extension, shown until the first read settles and the value it landed,
   *  if any, is told. */
  enter(firstRead: Promise<unknown>): Promise<void>;
  onRecompute(source: LoadOrderSource): void;
  dispose(): void;
}

function pending(log: (line: string) => void) {
  const held = new Set<Promise<void>>();
  return {
    track(work: Promise<void>): Promise<void> {
      const told = work.catch((e: unknown) => { log(`[loadOrder] handing mEdit the load order threw: ${errorMessage(e)}`); });
      held.add(told);
      void told.then(() => held.delete(told));
      return told;
    },
    settled: async (): Promise<void> => { await Promise.all([...held]); },
  };
}

export function editingFlow(deps: EditingDeps): EditingFlow {
  const { client, instanceRoot, around, tell, log } = deps;
  const tells = pending(log);
  const launches = pending(log);
  let entering = false;

  // A launch that failed is told by the launch, not again by the snapshot it was for.
  const tellPut = (put: Promise<PutLoadOrderResult>): void => {
    void tells.track(put.then((result) => {
      if (result.sent && result.outcome.outcome === 'backendFailed') return;
      return tell({ kind: 'put', put: result });
    }));
  };

  const tellLaunch = async (launched: Promise<LaunchOutcome>): Promise<void> => {
    const outcome = await launched;
    if (outcome.outcome === 'failed') {
      await tell(outcome.error === undefined ? { kind: 'backendFailed' } : { kind: 'launchFailed', reason: outcome.error });
      return;
    }
    if (outcome.outcome === 'stopped') return;
    await client.latestLoadOrder();
    await tells.settled();
  };

  const unsubscribes = [
    client.onLoadOrderResent((snapshot: LoadOrderSnapshot, outcome: LoadOrderOutcome) => {
      tellPut(Promise.resolve({ sent: true, snapshot, outcome }));
    }),
    client.onLaunch((launched) => {
      const shown = launches.track(tellLaunch(launched));
      if (!entering) void around(() => shown);
    }),
  ];

  return {
    enter: async (firstRead) => {
      entering = true;
      try {
        await around(async () => {
          await firstRead;
          await launches.settled();
          await tells.settled();
        });
      } finally {
        entering = false;
      }
    },
    onRecompute: (source) => { tellPut(putLoadOrder(client, instanceRoot, source)); },
    dispose: () => { for (const unsubscribe of unsubscribes) unsubscribe(); },
  };
}

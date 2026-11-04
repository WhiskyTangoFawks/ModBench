// Put load order (ADR-0013) at every recompute. The client owns the process the snapshot goes to;
// what came of each put comes back through `onPut`.

import type { LaunchOutcome, LoadOrderOutcome, LoadOrderSnapshot, MEditClient } from '../client';
import { errorMessage } from '../ports/errorMessage';
import { putLoadOrder, type InGameOrder, type LoadOrderSource, type PutLoadOrderResult } from './loadOrder';

export interface EditingDeps {
  client: Pick<MEditClient, 'sendLoadOrder' | 'onLoadOrderResent' | 'onLaunch' | 'latestLoadOrder'>;
  instanceRoot: string;
  /** The order the game loads in; `onChange` is the moment it may have changed, as Editing read the plugins. */
  inGameOrder: { of: InGameOrder; onChange(listener: () => void): { dispose(): void } };
  /** Shows a launch, from its start until the snapshot it was for is told (plugins.md, States 2). */
  around: (entry: () => Promise<void>) => Promise<void>;
  /** What came of a put: the snapshot sent and mEdit's outcome, or why nothing was sent. */
  onPut: (put: PutLoadOrderResult) => Promise<void>;
  /** The Output, for a tell that threw: no caller is left to hear it. */
  log: (line: string) => void;
}

export interface EditingFlow {
  /** The launch with the extension, shown until the first read settles and the value it landed,
   *  if any, is told. */
  enter(firstRead: Promise<unknown>): Promise<void>;
  onRecompute(source: LoadOrderSource, stringsLanguage: string | undefined): void;
  dispose(): void;
}

type Sent = Exclude<LoadOrderSource, undefined | { refusal: string }>;

function pending(logThrown: (reason: string) => void) {
  const held = new Set<Promise<void>>();
  return {
    track(work: Promise<void>): Promise<void> {
      const told = work.catch((e: unknown) => { logThrown(errorMessage(e)); });
      held.add(told);
      void told.then(() => held.delete(told));
      return told;
    },
    settled: async (): Promise<void> => { await Promise.all([...held]); },
  };
}

export function editingFlow(deps: EditingDeps): EditingFlow {
  const { client, instanceRoot, around, onPut, log } = deps;
  const tells = pending((reason) => { log(`[loadOrder] handing mEdit the load order threw: ${reason}`); });
  const launches = pending((reason) => { log(`[loadOrder] telling the launch of mEdit threw: ${reason}`); });
  let entering = false;
  let last: { source: Sent; stringsLanguage: string | undefined; order: string } | undefined;

  // A put the backend failed is not told: the status bar reports the stop.
  const tellPut = (put: Promise<PutLoadOrderResult>): void => {
    void tells.track(put.then((result) => {
      if (result.sent && result.outcome.outcome === 'backendFailed') return;
      return onPut(result);
    }));
  };

  const orderOf = (source: Sent): string => deps.inGameOrder.of(source).map(({ name, origin }) => `${origin}/${name}`).join('\n');

  const put = (source: LoadOrderSource, stringsLanguage: string | undefined): void => {
    last = source === undefined || 'refusal' in source ? undefined : { source, stringsLanguage, order: orderOf(source) };
    tellPut(putLoadOrder(client, instanceRoot, source, stringsLanguage, deps.inGameOrder.of));
  };

  const changeOfOrder = deps.inGameOrder.onChange(() => {
    if (last !== undefined && orderOf(last.source) !== last.order) put(last.source, last.stringsLanguage);
  });

  const tellLaunch = async (launched: Promise<LaunchOutcome>): Promise<void> => {
    const outcome = await launched;
    if (outcome.outcome !== 'running') return;
    await client.latestLoadOrder();
    await tells.settled();
  };

  const unsubscribes = [
    () => { changeOfOrder.dispose(); },
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
    onRecompute: put,
    dispose: () => { for (const unsubscribe of unsubscribes) unsubscribe(); },
  };
}

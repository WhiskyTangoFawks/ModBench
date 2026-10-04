// Entering editing and put load order (ADR-0013). Nothing is put while detached; a stream reopen
// is a start, the process behind it perhaps another.

import type { LoadOrderProgress, LoadOrderSender, MEditClient } from '../client';
import { enterEditingAcrossRestarts } from '../client';
import { errorMessage } from '../ports/errorMessage';
import { putLoadOrder, type LoadOrderSource } from './loadOrder';

export interface EditingDeps {
  client: Pick<MEditClient, 'status' | 'start' | 'onStatusChanged' | 'onReconnected'>;
  sender: Pick<LoadOrderSender, 'arm' | 'send'>;
  instance: {
    readonly value: LoadOrderSource;
    readonly sequence: number;
    refresh(): Promise<void>;
  };
  instanceRoot: string;
  narrator: {
    hear(status: LoadOrderProgress): void;
    settled(version: number): Promise<void>;
  };
  progress: {
    while(work: () => Promise<void>): Promise<void>;
    say(message: string): void;
  };
  log: { info(msg: string): void; error(msg: string): void };
  /** Tells the user an error. */
  report: (message: string) => void;
  revealLog: () => void;
  /** Takes the half-entered editing down. */
  leave: () => void;
}

export interface EditingFlow {
  /** Starts the backend and puts the load order. */
  enter(): Promise<void>;
  /** Puts the load order the instance value on screen carries, and reports the send's own answer. */
  put(): Promise<void>;
  /** The instance value recomputed. */
  onRecompute(): void;
  dispose(): void;
}

export function editingFlow(deps: EditingDeps): EditingFlow {
  const { client, sender, instance, instanceRoot, narrator, progress, log, report, revealLog, leave } = deps;
  let startPutRan = false;

  const put = async (): Promise<void> => {
    const { loadOrderSnapshot, gameName, gameRelease } = instance.value;
    const result = await putLoadOrder(sender, instanceRoot, { loadOrderSnapshot, gameName, gameRelease });
    // A game folder not found, or one whose plugins cannot be listed, is told by the views and the
    // Output already; a line per value would repeat it.
    if (!result.sent) return;
    const { plugins, active } = result.snapshot;
    log.info(`[toolbox] handed mEdit the load order snapshot (${plugins.length} plugins, ${active.length} active)`);
    const { outcome } = result;
    // An abandoned send says nothing: a superseded or closed send owns no view.
    if (outcome.outcome === 'failed') report(outcome.message);
    if (outcome.outcome !== 'applied') return;
    // The status the put waited for, heard here too: its ticks can be lost to a stream reopening.
    narrator.hear(outcome.status);
    await narrator.settled(outcome.status.version);
  };

  const putLogged = (): void => {
    void put().catch((e: unknown) => log.error(`[loadOrder] handing mEdit the load order threw: ${errorMessage(e)}`));
  };

  const enterOnce = async (): Promise<void> => {
    const { abandoned } = sender.arm();
    // Overlaps with the backend starting below: the reconcile must read a real Instance value,
    // never the empty pre-first-read sentinel.
    const instanceReady = instance.sequence > 0 ? Promise.resolve() : instance.refresh();
    revealLog();
    progress.say('Starting backend…');
    log.info('[toolbox] entering editing: starting backend');
    await client.start();
    // Before the status gate, deliberately: a close stops the backend, so an abandoned launch
    // would otherwise fail this check and report the stop it asked for as a startup failure.
    if (abandoned()) {
      log.info('[toolbox] the reconcile was abandoned before it landed; leaving the closed view alone');
      return;
    }
    if (client.status !== 'running') {
      leave();
      report('Backend failed to start — see the Modbench output for details.');
      return;
    }
    await instanceReady;
    // No snapshot to hand over: the views and the Output already say why, without a notification
    // (common.md, States, story 5).
    if (!instance.value.loadOrderSnapshot) {
      leave();
      return;
    }
    // Put whatever the backend before it held: the backend just attached holds no load order.
    startPutRan = true;
    await put();
  };

  const statusSubscription = client.onStatusChanged((status) => {
    if (status !== 'running') startPutRan = false;
  });
  const reconnectSubscription = client.onReconnected(() => {
    if (startPutRan) putLogged();
  });
  const entry = enterEditingAcrossRestarts(
    client, () => progress.while(enterOnce), (msg) => log.error(`[toolbox] ${msg}`));

  return {
    enter: entry.enter,
    put,
    onRecompute: () => { if (startPutRan) putLogged(); },
    dispose: () => {
      statusSubscription();
      reconnectSubscription();
      entry.dispose();
      startPutRan = false;
    },
  };
}

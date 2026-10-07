import { errorMessage } from '../ports/errorMessage';
import { isMEditGone, type BackendStatus, type LoadOrderOutcome, type LoadOrderSnapshot } from './MEditClient';

/** What an adapter gives the sender: its process, its stream's reopen, and one PUT of a snapshot. */
export interface LoadOrderWire {
  status(): BackendStatus;
  onStatusChanged(listener: (status: BackendStatus) => void): () => void;
  onReconnected(listener: () => void): () => void;
  start(): Promise<void>;
  stop(): Promise<void>;
  put(snapshot: LoadOrderSnapshot, signal: AbortSignal): Promise<LoadOrderOutcome>;
  log(message: string): void;
}

/** The one sender of ADR-0013's snapshot, and the owner of the process it is sent to. */
export interface LoadOrderSender {
  send(snapshot: LoadOrderSnapshot): Promise<LoadOrderOutcome>;
  latest(): Promise<LoadOrderOutcome | undefined>;
  onResent(listener: (snapshot: LoadOrderSnapshot, outcome: LoadOrderOutcome) => void): () => void;
  launch(): Promise<void>;
  stop(): Promise<void>;
}

const ABANDONED: LoadOrderOutcome = { outcome: 'abandoned' };
const BACKEND_FAILED: LoadOrderOutcome = { outcome: 'backendFailed' };

interface Waiting {
  snapshot: LoadOrderSnapshot;
  settle: (outcome: LoadOrderOutcome) => void;
}

// Swallowing the throw here is what keeps one bad send from wedging every send after it; the
// caller still hears the failure as this snapshot's own outcome (ADR-0019).
function putSnapshot(wire: LoadOrderWire, snapshot: LoadOrderSnapshot, signal: AbortSignal): Promise<LoadOrderOutcome> {
  return wire.put(snapshot, signal).catch((e: unknown): LoadOrderOutcome => ({
    outcome: 'failed',
    message: `Failed to send the load order — ${errorMessage(e)}`,
  }));
}

// One snapshot waits and one is in flight. An arrival replaces the one waiting, so the newest
// lands instead of a queue of stale ones each paying an index.
function createSendSlot(wire: LoadOrderWire) {
  let waiting: Waiting | undefined;
  let inFlight: AbortController | undefined;
  let newest: Promise<LoadOrderOutcome> | undefined;

  const drop = (outcome: LoadOrderOutcome): void => {
    const dropped = waiting;
    waiting = undefined;
    dropped?.settle(outcome);
  };

  // The backend publishes a PUT's progress the moment that PUT lands, so a snapshot waits for
  // mEdit to run rather than being sent into a backend that is not there yet.
  const pump = (): void => {
    if (inFlight || !waiting || wire.status() !== 'running') return;
    const next = waiting;
    waiting = undefined;
    const controller = new AbortController();
    inFlight = controller;
    void putSnapshot(wire, next.snapshot, controller.signal).then(next.settle).finally(() => {
      inFlight = undefined;
      pump();
    });
  };

  return {
    hold(snapshot: LoadOrderSnapshot): Promise<LoadOrderOutcome> {
      drop(ABANDONED);
      const sent = new Promise<LoadOrderOutcome>((settle) => { waiting = { snapshot, settle }; });
      newest = sent;
      pump();
      return sent;
    },
    holdsOne: () => waiting !== undefined,
    drop,
    pump,
    abortInFlight: () => { inFlight?.abort(); },
    async latest(): Promise<LoadOrderOutcome | undefined> {
      for (let asked = newest; asked !== undefined; asked = newest) {
        const outcome = await asked;
        if (asked === newest) return outcome;
      }
      return undefined;
    },
  };
}

export function createLoadOrderSender(wire: LoadOrderWire): LoadOrderSender {
  const slot = createSendSlot(wire);
  let newestHanded: LoadOrderSnapshot | undefined;
  let launching: Promise<void> | undefined;
  let stops = 0;
  let wentAway = false;
  const resentListeners = new Set<(snapshot: LoadOrderSnapshot, outcome: LoadOrderOutcome) => void>();

  // A launch cut short by a stop answers nothing of its own: the stop already abandoned the snapshot.
  const failedToCome = async (stopsAtLaunch: number): Promise<boolean> => {
    if (stops !== stopsAtLaunch) return false;
    try {
      await wire.start();
    } catch (e) {
      wire.log(`[mEdit client] launching mEdit failed: ${errorMessage(e)}`);
    }
    if (wire.status() === 'running' || stops !== stopsAtLaunch) return false;
    await wire.stop();
    return true;
  };

  const launch = (): Promise<void> => {
    const stopsAtLaunch = stops;
    // Held before the start runs, so a status the start reports at once finds the launch under way.
    launching ??= Promise.resolve().then(() => failedToCome(stopsAtLaunch)).then((failed) => {
      launching = undefined;
      if (failed) slot.drop(BACKEND_FAILED);
    });
    return launching;
  };

  const hand = (snapshot: LoadOrderSnapshot): Promise<LoadOrderOutcome> => {
    newestHanded = snapshot;
    const sent = slot.hold(snapshot);
    if (wire.status() !== 'running') void launch();
    return sent;
  };

  const resend = (): void => {
    const snapshot = newestHanded;
    if (!snapshot || slot.holdsOne()) return;
    void hand(snapshot).then((outcome) => {
      for (const listener of resentListeners) listener(snapshot, outcome);
    });
  };

  // A send in flight when mEdit goes answers abandoned, never a killed backend as a network
  // failure. The process that runs next holds nothing, so the newest snapshot goes again.
  wire.onStatusChanged((status) => {
    if (isMEditGone(status)) {
      wentAway = true;
      slot.abortInFlight();
      if (!launching) slot.drop(ABANDONED);
      return;
    }
    if (status === 'running' && wentAway) {
      wentAway = false;
      resend();
    }
    slot.pump();
  });
  wire.onReconnected(resend);

  return {
    send: hand,
    latest: () => slot.latest(),
    onResent(listener) {
      resentListeners.add(listener);
      return () => { resentListeners.delete(listener); };
    },
    launch,
    async stop() {
      stops++;
      newestHanded = undefined;
      slot.abortInFlight();
      slot.drop(ABANDONED);
      await wire.stop();
    },
  };
}

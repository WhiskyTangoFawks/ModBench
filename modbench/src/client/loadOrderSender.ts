import { errorMessage } from '../ports/errorMessage';
import { createLauncher, type LauncherWire } from './backendLifecycle';
import {
  isMEditGone, type BackendStatus, type LaunchOutcome, type LoadOrderOutcome, type LoadOrderSnapshot,
} from './MEditClient';

/** What an adapter gives the sender: its process, its stream's reopen, and one PUT of a snapshot. */
export interface LoadOrderWire extends LauncherWire {
  onStatusChanged(listener: (status: BackendStatus) => void): () => void;
  onReconnected(listener: () => void): () => void;
  put(snapshot: LoadOrderSnapshot, signal: AbortSignal): Promise<LoadOrderOutcome>;
}

/** The one sender of ADR-0013's snapshot, and the owner of the process it is sent to. */
export interface LoadOrderSender {
  send(snapshot: LoadOrderSnapshot): Promise<LoadOrderOutcome>;
  latest(): Promise<LoadOrderOutcome | undefined>;
  onResent(listener: (snapshot: LoadOrderSnapshot, outcome: LoadOrderOutcome) => void): () => void;
  onLaunch(listener: (launched: Promise<LaunchOutcome>) => void): () => void;
  onExit(listener: () => void): () => void;
  launch(): Promise<LaunchOutcome>;
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

/** A restarted mEdit holds only what was resent, so every view hears the resend as the change it is. */
export function announceResends(sender: Pick<LoadOrderSender, 'onResent'>, notifications: { announceChanged(snapshot: LoadOrderSnapshot): void }): void {
  sender.onResent((snapshot, outcome) => {
    if (outcome.outcome === 'applied') notifications.announceChanged(snapshot);
  });
}

function listeners<A extends unknown[]>() {
  const held = new Set<(...args: A) => void>();
  return {
    add: (listener: (...args: A) => void): (() => void) => {
      held.add(listener);
      return () => { held.delete(listener); };
    },
    fire: (...args: A): void => {
      for (const listener of held) listener(...args);
    },
  };
}

export function createLoadOrderSender(wire: LoadOrderWire): LoadOrderSender {
  const slot = createSendSlot(wire);
  let newestHanded: LoadOrderSnapshot | undefined;
  let reopenUnannounced = false;
  const resent = listeners<[LoadOrderSnapshot, LoadOrderOutcome]>();
  const launches = listeners<[Promise<LaunchOutcome>]>();
  const exits = listeners<[]>();
  const launcher = createLauncher(wire, launches.fire);

  const launch = (): Promise<LaunchOutcome> => {
    const launched = launcher.launch();
    void launched.then(({ outcome }) => { if (outcome === 'failed') slot.drop(BACKEND_FAILED); });
    return launched;
  };

  const hand = (snapshot: LoadOrderSnapshot): Promise<LoadOrderOutcome> => {
    if (launcher.stopped()) return Promise.resolve(ABANDONED);
    if (isMEditGone(wire.status()) && !launcher.launching()) return Promise.resolve(BACKEND_FAILED);
    newestHanded = snapshot;
    const sent = slot.hold(snapshot);
    void sent.then((outcome) => {
      if (!reopenUnannounced || outcome.outcome === 'abandoned' || snapshot !== newestHanded) return;
      reopenUnannounced = false;
      resent.fire(snapshot, outcome);
    });
    return sent;
  };

  // The newest snapshot to apply after a reopen is the resend, whether it is the one handed again
  // or one that was already waiting.
  const resend = (): void => {
    if (!newestHanded) return;
    reopenUnannounced = true;
    if (!slot.holdsOne()) void hand(newestHanded);
  };

  // A send in flight when mEdit goes answers abandoned, never a killed backend as a network failure.
  wire.onStatusChanged((status) => {
    if (isMEditGone(status)) {
      slot.abortInFlight();
      slot.drop(BACKEND_FAILED);
      if (!launcher.launching() && !launcher.stopped()) exits.fire();
      return;
    }
    slot.pump();
  });
  wire.onReconnected(resend);

  return {
    send: hand,
    latest: () => slot.latest(),
    onResent: resent.add,
    onLaunch: launches.add,
    onExit: exits.add,
    launch,
    async stop() {
      launcher.stop();
      newestHanded = undefined;
      reopenUnannounced = false;
      slot.abortInFlight();
      slot.drop(ABANDONED);
      await wire.stop();
    },
  };
}

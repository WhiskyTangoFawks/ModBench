import { errorMessage } from '../ports/errorMessage';
import { createLauncher, type LauncherWire } from './backendLifecycle';
import {
  isMEditGone, type BackendStatus, type LaunchOutcome, type LoadOrderOutcome, type LoadOrderSnapshot,
} from './MEditClient';

/** What an adapter gives the sender: its process, its stream's reopen, one PUT of a snapshot, which calls `answered` once
 *  mEdit has answered it, and one signal of a change, which never rejects. */
export interface LoadOrderWire extends LauncherWire {
  onStatusChanged(listener: (status: BackendStatus) => void): () => void;
  onReconnected(listener: () => void): () => void;
  put(snapshot: LoadOrderSnapshot, signal: AbortSignal, answered: () => void): Promise<LoadOrderOutcome>;
  signalChange(paths: readonly string[]): Promise<void>;
}

/** The one sender of ADR-0013's snapshot and ADR-0015's change signal, and the owner of the process they are sent to. */
export interface LoadOrderSender {
  send(snapshot: LoadOrderSnapshot): Promise<LoadOrderOutcome>;
  signalChange(paths: readonly string[]): void;
  latest(): Promise<LoadOrderOutcome | undefined>;
  onResent(listener: (snapshot: LoadOrderSnapshot, outcome: LoadOrderOutcome) => void): () => void;
  onAppliedAfterReopen(listener: (snapshot: LoadOrderSnapshot) => void): () => void;
  onLaunch(listener: (launched: Promise<LaunchOutcome>) => void): () => void;
  onExit(listener: () => void): () => void;
  launch(): Promise<LaunchOutcome>;
  stop(): Promise<void>;
}

const ABANDONED: LoadOrderOutcome = { outcome: 'abandoned' };
const SIGNAL_WAIT_CAP_MS = 10_000;
const BACKEND_FAILED: LoadOrderOutcome = { outcome: 'backendFailed' };

interface OwedSignal {
  readonly since: number;
  readonly paths: Set<string>;
  disk: boolean;
}

interface Waiting {
  snapshot: LoadOrderSnapshot;
  settle: (outcome: LoadOrderOutcome) => void;
}

// Swallowing the throw here is what keeps one bad send from wedging every send after it; the
// caller still hears the failure as this snapshot's own outcome (ADR-0019).
function putSnapshot(wire: LoadOrderWire, snapshot: LoadOrderSnapshot, signal: AbortSignal, answered: () => void): Promise<LoadOrderOutcome> {
  return wire.put(snapshot, signal, answered).catch((e: unknown): LoadOrderOutcome => ({
    outcome: 'failed',
    message: `Failed to send the load order — ${errorMessage(e)}`,
  }));
}

// One snapshot waits and one is in flight. An arrival replaces the one waiting, so the newest
// lands instead of a queue of stale ones each paying an index.
function createSendSlot(wire: LoadOrderWire) {
  let waiting: Waiting | undefined;
  let inFlight: AbortController | undefined;
  let unanswered = false;
  let newest: Promise<LoadOrderOutcome> | undefined;
  let owed: OwedSignal | undefined;
  let signalTimer: ReturnType<typeof setTimeout> | undefined;
  let signalling = false;

  const drop = (outcome: LoadOrderOutcome): void => {
    const dropped = waiting;
    waiting = undefined;
    dropped?.settle(outcome);
  };

  const sendWaiting = (next: Waiting): void => {
    const controller = new AbortController();
    inFlight = controller;
    unanswered = true;
    const answered = (): void => {
      if (inFlight !== controller || !unanswered) return;
      unanswered = false;
      pump();
    };
    void putSnapshot(wire, next.snapshot, controller.signal, answered).then(next.settle).finally(() => {
      unanswered = false;
      inFlight = undefined;
      pump();
    });
  };

  const sendSignal = (signal: OwedSignal): void => {
    owed = undefined;
    clearTimeout(signalTimer);
    signalTimer = undefined;
    signalling = true;
    void wire.signalChange(signal.disk ? [] : [...signal.paths]).finally(() => {
      signalling = false;
      pump();
    });
  };

  // A signal waits for the snapshots handed before it to be answered, so mEdit checks the load order it was handed,
  // and a stream of snapshots delays it by a bounded time.
  const pumpSignal = (): void => {
    if (owed === undefined || signalling) return;
    const waited = Date.now() - owed.since;
    if ((waiting || unanswered) && waited < SIGNAL_WAIT_CAP_MS) {
      signalTimer ??= setTimeout(() => { signalTimer = undefined; pump(); }, SIGNAL_WAIT_CAP_MS - waited);
      return;
    }
    sendSignal(owed);
  };

  // The backend publishes a PUT's progress the moment that PUT lands, so a snapshot waits for
  // mEdit to run rather than being sent into a backend that is not there yet.
  const pump = (): void => {
    if (wire.status() !== 'running') return;
    if (!inFlight && waiting) {
      const next = waiting;
      waiting = undefined;
      sendWaiting(next);
    }
    pumpSignal();
  };

  return {
    hold(snapshot: LoadOrderSnapshot): Promise<LoadOrderOutcome> {
      drop(ABANDONED);
      const sent = new Promise<LoadOrderOutcome>((settle) => { waiting = { snapshot, settle }; });
      newest = sent;
      pump();
      return sent;
    },
    oweSignal(paths: readonly string[]): void {
      owed ??= { since: Date.now(), paths: new Set(), disk: false };
      owed.disk ||= paths.length === 0;
      for (const path of paths) owed.paths.add(path);
      pump();
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

interface ChangeAnnouncer {
  announceChanged(snapshot: LoadOrderSnapshot): void;
}

/** A restarted mEdit holds only what was resent, so every view hears the first snapshot applied after a reopen as the change it is. */
export function announceAfterReopen(sender: Pick<LoadOrderSender, 'onAppliedAfterReopen'>, notifications: ChangeAnnouncer): void {
  sender.onAppliedAfterReopen((snapshot) => { notifications.announceChanged(snapshot); });
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
  const appliedAfterReopen = listeners<[LoadOrderSnapshot]>();
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
      if (!reopenUnannounced || outcome.outcome !== 'applied' || snapshot !== newestHanded) return;
      reopenUnannounced = false;
      appliedAfterReopen.fire(snapshot);
    });
    return sent;
  };

  const resend = (): void => {
    const snapshot = newestHanded;
    if (!snapshot) return;
    reopenUnannounced = true;
    if (!slot.holdsOne()) void hand(snapshot).then((outcome) => { resent.fire(snapshot, outcome); });
    slot.oweSignal([]);
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
    signalChange: (paths) => { if (!launcher.stopped()) slot.oweSignal(paths); },
    latest: () => slot.latest(),
    onResent: resent.add,
    onAppliedAfterReopen: appliedAfterReopen.add,
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

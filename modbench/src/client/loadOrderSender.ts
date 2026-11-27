import { EventEmitter } from './eventEmitter';
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
  signalChange(paths: readonly string[]): Promise<SweepEnd>;
}

/** What a posted signal started: `ended` settles once mEdit's sweep over what it named is over. */
export interface SweepEnd {
  readonly ended: Promise<void>;
}

/** The one sender of ADR-0013's snapshot and its change signal, and the owner of the process they are sent to. */
export interface LoadOrderSender {
  send(snapshot: LoadOrderSnapshot): Promise<LoadOrderOutcome>;
  /** Settles once the sweep the signal starts is over, at once when mEdit is gone: the signal is then owed. */
  signalChange(paths: readonly string[]): Promise<void>;
  latest(): Promise<LoadOrderOutcome | undefined>;
  /** Resolves once the newest snapshot handed has been answered, or dropped, ahead of the sweep that follows it. False when
   *  none was handed. */
  applied(): Promise<boolean>;
  handed(): number;
  /** Whether a snapshot or a change signal is waiting, in flight or owed. */
  pending(): boolean;
  /** Told wherever `pending` may have changed. */
  onPendingChanged(listener: () => void): () => void;
  onLaunch(listener: (launched: Promise<LaunchOutcome>) => void): () => void;
  onExit(listener: () => void): () => void;
  launch(): Promise<LaunchOutcome>;
  stop(): Promise<void>;
}

const ABANDONED: LoadOrderOutcome = { outcome: 'abandoned' };
const BACKEND_FAILED: LoadOrderOutcome = { outcome: 'backendFailed' };

interface OwedSignal {
  since?: number;
  readonly paths: Set<string>;
  disk: boolean;
  done: Promise<void>;
  sweepStarted: (ended: Promise<void>) => void;
}

function awaitingSweep(): Pick<OwedSignal, 'done' | 'sweepStarted'> {
  let sweepStarted!: (ended: Promise<void>) => void;
  const done = new Promise<void>((resolve) => { sweepStarted = resolve; });
  return { done, sweepStarted };
}

interface Waiting {
  snapshot: LoadOrderSnapshot;
  settle: (outcome: LoadOrderOutcome) => void;
  applied: () => void;
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
function createSendSlot(wire: LoadOrderWire, sendable: () => boolean, signalWaitCapMs: number, changed: () => void) {
  let waiting: Waiting | undefined;
  let inFlight: AbortController | undefined;
  let unanswered = false;
  let newest: { sent: Promise<LoadOrderOutcome>; applied: Promise<void> } | undefined;
  let owed: OwedSignal | undefined;
  let signalTimer: ReturnType<typeof setTimeout> | undefined;
  let signalling = false;

  const drop = (outcome: LoadOrderOutcome): void => {
    const dropped = waiting;
    waiting = undefined;
    dropped?.settle(outcome);
    changed();
  };

  const sendWaiting = (next: Waiting): void => {
    const controller = new AbortController();
    inFlight = controller;
    unanswered = true;
    const answered = (): void => {
      next.applied();
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
    void wire.signalChange(signal.disk ? [] : [...signal.paths]).then(({ ended }) => { signal.sweepStarted(ended); }).finally(() => {
      signalling = false;
      pump();
    });
  };

  // A signal waits for the snapshots handed before it to be answered, so mEdit checks the load order it was handed,
  // and a stream of snapshots delays it by a bounded time.
  const pumpSignal = (): void => {
    if (owed === undefined || signalling) return;
    owed.since ??= Date.now();
    const waited = Date.now() - owed.since;
    if ((waiting || unanswered) && waited < signalWaitCapMs) {
      signalTimer ??= setTimeout(() => { signalTimer = undefined; pump(); }, signalWaitCapMs - waited);
      return;
    }
    sendSignal(owed);
  };

  // The backend publishes a PUT's progress the moment that PUT lands, so a snapshot waits for
  // mEdit to run rather than being sent into a backend that is not there yet.
  const advance = (): void => {
    if (!sendable()) return;
    if (!inFlight && waiting) {
      const next = waiting;
      waiting = undefined;
      sendWaiting(next);
    }
    pumpSignal();
  };
  const pump = (): void => {
    advance();
    changed();
  };

  const ofNewest = async <T>(of: (handed: NonNullable<typeof newest>) => Promise<T>): Promise<T | undefined> => {
    for (let asked = newest; asked !== undefined; asked = newest) {
      const result = await of(asked);
      if (asked === newest) return result;
    }
    return undefined;
  };

  return {
    hold(snapshot: LoadOrderSnapshot): Promise<LoadOrderOutcome> {
      drop(ABANDONED);
      let applied!: () => void;
      const appliedPromise = new Promise<void>((resolve) => { applied = resolve; });
      const sent = new Promise<LoadOrderOutcome>((settle) => {
        waiting = { snapshot, settle: (outcome) => { applied(); settle(outcome); }, applied };
      });
      newest = { sent, applied: appliedPromise };
      pump();
      return sent;
    },
    oweSignal(paths: readonly string[]): Promise<void> {
      owed ??= { paths: new Set(), disk: false, ...awaitingSweep() };
      const { done } = owed;
      owed.disk ||= paths.length === 0;
      for (const path of paths) owed.paths.add(path);
      pump();
      return done;
    },
    /** Settles every caller waiting on the owed signal, which stays owed for the next run. */
    releaseSignalWaiters(): void {
      if (owed === undefined) return;
      owed.sweepStarted(Promise.resolve());
      Object.assign(owed, awaitingSweep());
    },
    pending: () => waiting !== undefined || inFlight !== undefined || owed !== undefined || signalling,
    drop,
    pump,
    abortInFlight: () => { inFlight?.abort(); },
    applied: async (): Promise<boolean> => (await ofNewest(async (handed) => { await handed.applied; return true; })) ?? false,
    latest: (): Promise<LoadOrderOutcome | undefined> => ofNewest((handed) => handed.sent),
  };
}

/** `signalWaitCapMs` bounds how long a change signal waits for the snapshots handed before it to be answered. */
export function createLoadOrderSender(wire: LoadOrderWire, signalWaitCapMs: number): LoadOrderSender {
  const pendingChanges = new EventEmitter();
  const launches = new EventEmitter<Promise<LaunchOutcome>>();
  const exits = new EventEmitter();
  const launcher = createLauncher(wire, (launched) => { launches.fire(launched); });
  const sendable = (): boolean => !launcher.stopped() && wire.status() === 'running';
  const slot = createSendSlot(wire, sendable, signalWaitCapMs, () => { pendingChanges.fire(); });
  let newestHanded: LoadOrderSnapshot | undefined;
  let handedCount = 0;
  const subscribeTo = <T>(emitter: EventEmitter<T>) => (listener: (data: T) => void): (() => void) => {
    const subscription = emitter.event(listener);
    return () => { subscription.dispose(); };
  };

  const launch = (): Promise<LaunchOutcome> => {
    const launched = launcher.launch();
    void launched.then(({ outcome }) => { if (outcome === 'failed') slot.drop(BACKEND_FAILED); });
    return launched;
  };

  const hand = (snapshot: LoadOrderSnapshot): Promise<LoadOrderOutcome> => {
    if (launcher.stopped()) return Promise.resolve(ABANDONED);
    if (isMEditGone(wire.status()) && !launcher.launching()) return Promise.resolve(BACKEND_FAILED);
    newestHanded = snapshot;
    handedCount++;
    return slot.hold(snapshot);
  };

  const oweCheckAfterReopen = (): void => {
    if (newestHanded) void slot.oweSignal([]);
  };

  // A send in flight when mEdit goes answers abandoned, never a killed backend as a network failure.
  wire.onStatusChanged((status) => {
    if (isMEditGone(status)) {
      slot.abortInFlight();
      slot.drop(BACKEND_FAILED);
      slot.releaseSignalWaiters();
      if (!launcher.launching() && !launcher.stopped()) exits.fire();
      return;
    }
    slot.pump();
  });
  wire.onReconnected(oweCheckAfterReopen);

  return {
    send: hand,
    signalChange: (paths) => {
      if (launcher.stopped()) return Promise.resolve();
      const done = slot.oweSignal(paths);
      if (isMEditGone(wire.status())) slot.releaseSignalWaiters();
      return done;
    },
    latest: () => slot.latest(),
    applied: () => slot.applied(),
    handed: () => handedCount,
    pending: () => slot.pending(),
    onPendingChanged: subscribeTo(pendingChanges),
    onLaunch: subscribeTo(launches),
    onExit: subscribeTo(exits),
    launch,
    async stop() {
      launcher.stop();
      newestHanded = undefined;
      slot.abortInFlight();
      slot.drop(ABANDONED);
      slot.releaseSignalWaiters();
      await wire.stop();
    },
  };
}

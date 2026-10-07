import { errorMessage } from '../ports/errorMessage';
import {
  isMEditGone, type BackendStatus, type LaunchOutcome, type LoadOrderOutcome, type LoadOrderSnapshot,
} from './MEditClient';

/** What an adapter gives the sender: its process, its stream's reopen, and one PUT of a snapshot. */
export interface LoadOrderWire {
  status(): BackendStatus;
  onStatusChanged(listener: (status: BackendStatus) => void): () => void;
  onReconnected(listener: () => void): () => void;
  start(): Promise<void>;
  stop(): Promise<void>;
  put(snapshot: LoadOrderSnapshot, signal: AbortSignal): Promise<LoadOrderOutcome>;
}

/** The one sender of ADR-0013's snapshot, and the owner of the process it is sent to. */
export interface LoadOrderSender {
  send(snapshot: LoadOrderSnapshot): Promise<LoadOrderOutcome>;
  latest(): Promise<LoadOrderOutcome | undefined>;
  onResent(listener: (snapshot: LoadOrderSnapshot, outcome: LoadOrderOutcome) => void): () => void;
  onLaunch(listener: (launched: Promise<LaunchOutcome>) => void): () => void;
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

const RUNNING: LaunchOutcome = { outcome: 'running' };
const STOPPED: LaunchOutcome = { outcome: 'stopped' };

// One launch at a time; a launch asked for while one runs shares it. A stop cuts a launch short,
// and the stop, not the launch, answers the snapshot it was for.
function createLauncher(wire: LoadOrderWire, announce: (launched: Promise<LaunchOutcome>) => void) {
  let launching: Promise<LaunchOutcome> | undefined;
  let stops = 0;

  const comeUp = async (stopsAtLaunch: number): Promise<LaunchOutcome> => {
    if (stops !== stopsAtLaunch) return STOPPED;
    let error: string | undefined;
    try {
      await wire.start();
    } catch (e) {
      error = errorMessage(e);
    }
    if (stops !== stopsAtLaunch) return STOPPED;
    if (wire.status() === 'running') return RUNNING;
    await wire.stop();
    return error === undefined ? { outcome: 'failed' } : { outcome: 'failed', error };
  };

  return {
    launch(): Promise<LaunchOutcome> {
      if (launching) return launching;
      const stopsAtLaunch = stops;
      // Held before the start runs, so a status the start reports at once finds the launch under way.
      const launched = Promise.resolve().then(() => comeUp(stopsAtLaunch));
      launching = launched;
      void launched.then(() => { launching = undefined; });
      announce(launched);
      return launched;
    },
    launching: () => launching !== undefined,
    stopped: () => { stops++; },
  };
}

export function createLoadOrderSender(wire: LoadOrderWire): LoadOrderSender {
  const slot = createSendSlot(wire);
  let newestHanded: LoadOrderSnapshot | undefined;
  let wentAway = false;
  const resentListeners = new Set<(snapshot: LoadOrderSnapshot, outcome: LoadOrderOutcome) => void>();
  const launchListeners = new Set<(launched: Promise<LaunchOutcome>) => void>();
  const announce = (launched: Promise<LaunchOutcome>): void => {
    for (const listener of launchListeners) listener(launched);
  };
  const launcher = createLauncher(wire, announce);

  const launch = (): Promise<LaunchOutcome> => {
    const launched = launcher.launch();
    void launched.then(({ outcome }) => { if (outcome === 'failed') slot.drop(BACKEND_FAILED); });
    return launched;
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
      if (!launcher.launching()) slot.drop(ABANDONED);
      return;
    }
    if (status === 'running' && wentAway) {
      wentAway = false;
      resend();
      if (!launcher.launching()) announce(Promise.resolve(RUNNING));
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
    onLaunch(listener) {
      launchListeners.add(listener);
      return () => { launchListeners.delete(listener); };
    },
    launch,
    async stop() {
      launcher.stopped();
      newestHanded = undefined;
      slot.abortInFlight();
      slot.drop(ABANDONED);
      await wire.stop();
    },
  };
}

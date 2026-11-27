import { isMEditGone, type LaunchOutcome, type LoadOrderOutcome, type LoadOrderSnapshot, type MEditClient } from '..';

type BackendStatus = MEditClient['status'];

/** What the in-memory client scripts of mEdit: its status, how a start and a stop go, and the answer to each PUT and
 *  each change signal. */
export interface ScriptedMEdit {
  status(): BackendStatus;
  onStatusChanged(listener: (status: BackendStatus) => void): () => void;
  start(): Promise<void>;
  stop(): void;
  put(snapshot: LoadOrderSnapshot, signal: AbortSignal): Promise<LoadOrderOutcome>;
  signalChange(paths: readonly string[]): Promise<void>;
}

const ABANDONED: LoadOrderOutcome = { outcome: 'abandoned' };
const BACKEND_FAILED: LoadOrderOutcome = { outcome: 'backendFailed' };

interface Waiting {
  readonly snapshot: LoadOrderSnapshot;
  readonly settle: (outcome: LoadOrderOutcome) => void;
}

interface Owed {
  readonly paths: Set<string>;
  disk: boolean;
  readonly waiters: (() => void)[];
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const tellAll = <T extends unknown[]>(listeners: Set<(...args: T) => void>, ...args: T): void => {
  for (const listener of [...listeners]) listener(...args);
};

const subscribe = <T extends unknown[]>(listeners: Set<(...args: T) => void>) => (listener: (...args: T) => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

/** The in-memory client's load order and launch, as the client's contract tells them, but keeping no time: a change
 *  signal waits for every snapshot handed before it to answer. */
export function inMemorySender(mEdit: ScriptedMEdit) {
  const launches = new Set<(launched: Promise<LaunchOutcome>) => void>();
  const exits = new Set<() => void>();
  const pendingChanged = new Set<() => void>();
  let ended = false;
  let launching: Promise<LaunchOutcome> | undefined;
  let waiting: Waiting | undefined;
  let inFlight: AbortController | undefined;
  let newest: { sent: Promise<LoadOrderOutcome>; answered: Promise<void> } | undefined;
  let owed: Owed | undefined;
  let signalling = false;
  let handed = 0;

  const drop = (outcome: LoadOrderOutcome): void => {
    waiting?.settle(outcome);
    waiting = undefined;
    tellAll(pendingChanged);
  };

  const releaseSignalWaiters = (): void => {
    for (const waiter of owed?.waiters.splice(0) ?? []) waiter();
  };

  const sendWaiting = ({ snapshot, settle }: Waiting): void => {
    const controller = new AbortController();
    waiting = undefined;
    inFlight = controller;
    void mEdit.put(snapshot, controller.signal)
      .catch((e: unknown): LoadOrderOutcome => ({ outcome: 'failed', message: `Failed to send the load order — ${messageOf(e)}` }))
      .then(settle)
      .finally(() => {
        if (inFlight === controller) inFlight = undefined;
        pump();
      });
  };

  const sendOwed = ({ paths, disk, waiters }: Owed): void => {
    owed = undefined;
    signalling = true;
    void mEdit.signalChange(disk ? [] : [...paths]).finally(() => {
      signalling = false;
      for (const waiter of waiters) waiter();
      pump();
    });
  };

  function pump(): void {
    if (ended || mEdit.status() !== 'running') return;
    if (inFlight === undefined && waiting !== undefined) sendWaiting(waiting);
    if (owed !== undefined && !signalling && inFlight === undefined && waiting === undefined) sendOwed(owed);
    tellAll(pendingChanged);
  }

  const comeUp = async (): Promise<LaunchOutcome> => {
    const errors: string[] = [];
    await mEdit.start().catch((e: unknown) => { errors.push(messageOf(e)); });
    if (ended) return { outcome: 'stopped' };
    if (mEdit.status() === 'running') return { outcome: 'running' };
    try {
      mEdit.stop();
    } catch (e) {
      errors.push(messageOf(e));
    }
    drop(BACKEND_FAILED);
    return errors.length === 0 ? { outcome: 'failed' } : { outcome: 'failed', error: errors.join('; ') };
  };

  const signalChange = (paths: readonly string[]): Promise<void> => {
    if (ended) return Promise.resolve();
    owed ??= { paths: new Set(), disk: false, waiters: [] };
    owed.disk ||= paths.length === 0;
    for (const path of paths) owed.paths.add(path);
    const done = new Promise<void>((resolve) => { owed?.waiters.push(resolve); });
    if (isMEditGone(mEdit.status())) releaseSignalWaiters();
    pump();
    return done;
  };

  mEdit.onStatusChanged((status) => {
    if (!isMEditGone(status)) {
      pump();
      return;
    }
    inFlight?.abort();
    drop(BACKEND_FAILED);
    releaseSignalWaiters();
    if (launching === undefined && !ended) tellAll(exits);
  });

  const ofNewest = async <T>(of: (sent: NonNullable<typeof newest>) => Promise<T>): Promise<T | undefined> => {
    for (let asked = newest; asked !== undefined; asked = newest) {
      const result = await of(asked);
      if (asked === newest) return result;
    }
    return undefined;
  };

  return {
    launch(): Promise<LaunchOutcome> {
      if (ended) return Promise.resolve({ outcome: 'stopped' });
      if (launching) return launching;
      const launched = Promise.resolve().then(comeUp);
      launching = launched;
      void launched.then(() => { launching = undefined; });
      tellAll(launches, launched);
      return launched;
    },
    stop(): Promise<void> {
      ended = true;
      inFlight?.abort();
      drop(ABANDONED);
      releaseSignalWaiters();
      mEdit.stop();
      return Promise.resolve();
    },
    send(snapshot: LoadOrderSnapshot): Promise<LoadOrderOutcome> {
      if (ended) return Promise.resolve(ABANDONED);
      if (isMEditGone(mEdit.status()) && launching === undefined) return Promise.resolve(BACKEND_FAILED);
      handed += 1;
      drop(ABANDONED);
      let answered!: () => void;
      const answer = new Promise<void>((resolve) => { answered = resolve; });
      const sent = new Promise<LoadOrderOutcome>((settle) => {
        waiting = { snapshot, settle: (outcome) => { answered(); settle(outcome); } };
      });
      newest = { sent, answered: answer };
      pump();
      return sent;
    },
    signalChange,
    /** The stream reopened: mEdit checks the disk once the snapshots handed before have answered. */
    reopened: (): void => { if (newest !== undefined) void signalChange([]); },
    latest: (): Promise<LoadOrderOutcome | undefined> => ofNewest((sent) => sent.sent),
    applied: async (): Promise<boolean> => (await ofNewest(async (sent) => { await sent.answered; return true; })) ?? false,
    handed: (): number => handed,
    pending: (): boolean => waiting !== undefined || inFlight !== undefined || owed !== undefined || signalling,
    onPendingChanged: subscribe(pendingChanged),
    onLaunch: subscribe(launches),
    onExit: subscribe(exits),
  };
}

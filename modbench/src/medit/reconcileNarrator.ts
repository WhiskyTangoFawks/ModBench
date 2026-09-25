import {
  toLoadOrderStatus, type LoadOrderProgress, type LoadOrderRefusal, type MEditClient, type PluginLoadFailure,
} from '../client';
import { errorMessage } from '../ports/errorMessage';
import { makeReconcileProgressHandler, reportIndexRefusal } from './loadOrderProgress';

export interface ReconcileNarratorDeps {
  /** Opens the Plugins view's progress, closed when `until` settles. */
  showProgress: (until: Promise<void>) => void;
  applyIndexed: (indexedPlugins: string[], failures: PluginLoadFailure[]) => void;
  /** plugins.md, States 4: the load order's own refusal, handed to the Plugins tree alongside the
   *  status bar so every row names it too. */
  applyRefused: (refusal: LoadOrderRefusal) => void;
  setStatusText: (text: string) => void;
  /** A reconcile reached Ready: its whole hand-off to the views. */
  settle: (status: LoadOrderProgress) => Promise<void>;
  log: (msg: string) => void;
}

/** A wait armed for a rebuild's refill. A rebuild refused starts none, so its wait is released. */
export interface RefillWait {
  ended: Promise<void>;
  release(): void;
}

export interface ReconcileNarrator {
  hear(status: LoadOrderProgress): void;
  /** Resolves once a reconcile answering at least `version` has been handed to the views. */
  settled(version: number): Promise<void>;
  /** Armed before a rebuild is asked for: resolves once the refill that follows ends, and at once
   *  when the index held nothing to refill. */
  nextRefill(): RefillWait;
  /** mEdit went away: the progress closes, every wait ends, and the next process's versions
   *  start over. */
  detached(): void;
}

interface Span {
  close: () => void;
  tick: (status: LoadOrderProgress) => void;
}

const terminal = (status: LoadOrderProgress): boolean =>
  status.conflictsComputed || status.refusal !== undefined;

/** The narrator hears every index status the stream carries; the answer is the unsubscribe. */
export function subscribeNarratorToLoadOrderStatus(
  client: Pick<MEditClient, 'subscribe'>, narrator: ReconcileNarrator,
): () => void {
  return client.subscribe('load-order-status', (event) => {
    if (event.loadOrderStatus) narrator.hear(toLoadOrderStatus(event.loadOrderStatus));
  });
}

// plugins.md, States 2: the index status says what the Plugins view shows, whoever started the
// reconcile — a put, a rebuild's refill or the watcher.
export function createReconcileNarrator(deps: ReconcileNarratorDeps): ReconcileNarrator {
  let last: LoadOrderProgress | undefined;
  let span: Span | undefined;
  let settledVersion = -1;
  // The highest version whose hand-off is queued, so a Ready heard again meanwhile queues none.
  let queuedVersion = -1;
  let handingOver = Promise.resolve();
  // Bumped when mEdit goes away, so a hand-off still running marks nothing for the next process.
  let generation = 0;
  const settleWaits = versionWaits();
  const refillWaits = refillWaitList();

  const closeSpan = (): boolean => {
    const was = span;
    span = undefined;
    was?.close();
    return was !== undefined;
  };

  const markSettled = (version: number): void => {
    settledVersion = Math.max(settledVersion, version);
    settleWaits.release(settledVersion);
  };

  const settle = (status: LoadOrderProgress, reconcileSeen: boolean): void => {
    if (status.refusal !== undefined) {
      reportIndexRefusal(status, deps);
      deps.applyRefused(status.refusal);
      markSettled(status.version);
      return;
    }
    if (!reconcileSeen && status.version <= Math.max(settledVersion, queuedVersion)) return;
    queuedVersion = Math.max(queuedVersion, status.version);
    const handedBy = generation;
    handingOver = handingOver
      .then(() => deps.settle(status))
      .catch((e: unknown) => deps.log(`handing the reconciled load order to the views threw: ${errorMessage(e)}`))
      .then(() => { if (handedBy === generation) markSettled(status.version); });
  };

  return {
    hear(status) {
      last = status;
      if (terminal(status)) {
        const reconcileSeen = closeSpan();
        refillWaits.end(false);
        settle(status, reconcileSeen);
        return;
      }
      refillWaits.started();
      if (status.holdsNone) {
        closeSpan();
        deps.applyIndexed([], []);
        return;
      }
      span ??= openSpan(deps);
      span.tick(status);
    },
    settled: (version) => (version <= settledVersion ? Promise.resolve() : settleWaits.arm(version)),
    nextRefill: () => (!last || last.holdsNone ? { ended: Promise.resolve(), release: () => {} } : refillWaits.arm()),
    detached() {
      generation++;
      closeSpan();
      refillWaits.end(true);
      settleWaits.release(Number.MAX_SAFE_INTEGER);
      settledVersion = -1;
      queuedVersion = -1;
      last = undefined;
    },
  };
}

function openSpan(deps: ReconcileNarratorDeps): Span {
  let close!: () => void;
  deps.showProgress(new Promise<void>((resolve) => { close = resolve; }));
  return { close, tick: makeReconcileProgressHandler({ applyLoadOrder: deps.applyIndexed }) };
}

function versionWaits() {
  let waits: { version: number; resolve: () => void }[] = [];
  return {
    arm: (version: number) => new Promise<void>((resolve) => { waits.push({ version, resolve }); }),
    release(upTo: number) {
      const done = waits.filter((w) => w.version <= upTo);
      waits = waits.filter((w) => w.version > upTo);
      for (const w of done) w.resolve();
    },
  };
}

// A wait ends at the first terminal status after its refill started: a Ready heard before the
// rebuild dropped the index is the load order before, not the refill.
function refillWaitList() {
  let waits: { refillStarted: boolean; resolve: () => void }[] = [];
  return {
    arm(): RefillWait {
      let wait!: { refillStarted: boolean; resolve: () => void };
      const ended = new Promise<void>((resolve) => { wait = { refillStarted: false, resolve }; });
      waits.push(wait);
      return {
        ended,
        release: () => {
          waits = waits.filter((w) => w !== wait);
          wait.resolve();
        },
      };
    },
    started() { for (const w of waits) w.refillStarted = true; },
    end(all: boolean) {
      const done = waits.filter((w) => all || w.refillStarted);
      waits = waits.filter((w) => !(all || w.refillStarted));
      for (const w of done) w.resolve();
    },
  };
}

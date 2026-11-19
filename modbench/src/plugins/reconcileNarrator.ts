import type { LoadOrderRefusal, PluginAddress, PluginLoadFailure, RecordIndexProgress } from '../client';
import { errorMessage } from '../ports/errorMessage';
import { makeReconcileProgressHandler } from './loadOrderProgress';

/** What the record index has done with the load order: how far, and which plugins it holds and which it failed. */
export interface Heard {
  readonly progress: RecordIndexProgress;
  readonly indexed: readonly PluginAddress[];
  readonly failures: readonly PluginLoadFailure[];
}

export interface ReconcileNarratorDeps {
  /** Opens the Plugins view's progress, closed when `until` settles. */
  showProgress: (until: Promise<void>) => void;
  applyIndexed: (indexedPlugins: readonly PluginAddress[], failures: readonly PluginLoadFailure[]) => void;
  /** plugins.md, States 4 and 6: the load order's own refusal. */
  applyRefused: (refusal: LoadOrderRefusal) => void;
  /** A reconcile reached Ready: its whole hand-off to the views. */
  settle: (heard: Heard) => Promise<void>;
  log: (msg: string) => void;
}

interface RefillWait {
  ended: Promise<void>;
  release(): void;
}

export interface ReconcileNarrator {
  hear(heard: Heard): void;
  /** Resolves once a reconcile answering at least `version` has been handed to the views. */
  settled(version: number): Promise<void>;
  /** Armed before a rebuild is asked for: resolves once the refill that follows ends, and at once
   *  when the record index held nothing to refill. */
  nextRefill(): RefillWait;
  /** mEdit went away: the progress closes, every wait ends, and the next process's versions
   *  start over. */
  detached(): void;
}

interface Span {
  close: () => void;
  tick: (heard: Heard) => void;
}

// plugins.md, States, story 6: the record index status says what the Plugins view shows, whoever started the
// reconcile — a put, a rebuild's refill or the watcher.
export function createReconcileNarrator(deps: ReconcileNarratorDeps): ReconcileNarrator {
  let last: Heard | undefined;
  let span: Span | undefined;
  let settledVersion = -1;
  // A check reports its failure under the version it checked.
  let loggedFailure: { version: number; message: string } | undefined;
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

  const settle = (heard: Heard, reconcileSeen: boolean): void => {
    const { refusal, version } = heard.progress;
    if (refusal !== undefined) {
      if (refusal.kind === 'failed' && (version > (loggedFailure?.version ?? -1) || refusal.message !== loggedFailure?.message)) {
        loggedFailure = { version, message: refusal.message };
        deps.log(`Indexing failed: ${refusal.message}`);
      }
      deps.applyRefused(refusal);
      markSettled(version);
      return;
    }
    if (!reconcileSeen && version <= Math.max(settledVersion, queuedVersion)) return;
    queuedVersion = Math.max(queuedVersion, version);
    const handedBy = generation;
    handingOver = handingOver
      .then(() => deps.settle(heard))
      .catch((e: unknown) => deps.log(`handing the reconciled load order to the views threw: ${errorMessage(e)}`))
      .then(() => { if (handedBy === generation) markSettled(version); });
  };

  return {
    hear(heard) {
      last = heard;
      if (heard.progress.refusal?.kind !== 'failed') loggedFailure = undefined;
      if (heard.progress.settled || heard.progress.refusal !== undefined) {
        const reconcileSeen = closeSpan();
        refillWaits.end(false);
        settle(heard, reconcileSeen);
        return;
      }
      refillWaits.started();
      span ??= openSpan(deps);
      span.tick(heard);
    },
    settled: (version) => (version <= settledVersion ? Promise.resolve() : settleWaits.arm(version)),
    nextRefill: () => (!last ? { ended: Promise.resolve(), release: () => {} } : refillWaits.arm()),
    detached() {
      generation++;
      closeSpan();
      refillWaits.end(true);
      settleWaits.release(Number.MAX_SAFE_INTEGER);
      settledVersion = -1;
      queuedVersion = -1;
      last = undefined;
      loggedFailure = undefined;
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
// rebuild dropped the record index is the load order before, not the refill.
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

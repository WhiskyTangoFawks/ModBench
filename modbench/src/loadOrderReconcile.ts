/** ADR-0044: the one path by which the Plugin load order reaches Editing, coalesced — a burst of
 *  triggers becomes one snapshot, and a request arriving mid-PUT becomes exactly one more PUT
 *  after it, never a race of two. */
export interface LoadOrderSyncDeps<TPlugin = unknown, TProgress = unknown, TOffer = unknown>
  extends ReconcileStepDepsWithoutArm<TPlugin, TProgress, TOffer> {
  /** How long to wait for a burst to finish before sending. Two watchers can fire for one
   *  mod-level change, and a drag reorder rewrites plugins.txt once per drop — none of those
   *  deserve a PUT each. */
  debounceMs: number;
  log: (msg: string) => void;
  /** Wraps one whole reconcile in whatever progress indicator the trigger wants shown — every
   *  `request()`/`flush()` gets one. */
  withProgress: (work: () => Promise<void>) => Promise<void>;
}

// Minus `arm`: this module owns the abort scope, the one step it does not take opaque.
type ReconcileStepDepsWithoutArm<TPlugin, TProgress, TOffer> = Omit<ReconcileStepDeps<TPlugin, TProgress, TOffer>, 'arm'>;

export interface LoadOrderSync {
  /** Something that feeds the load order changed: send a snapshot soon, coalesced with any other
   *  request that lands in the same window. */
  request(): void;
  /** Send now, waiting for any in-flight send first. Resolves with the outcome of the run this
   *  call itself causes, never a later run it coalesced with; `undefined` only when nothing was
   *  sent at all, which today means disposed. */
  flush(): Promise<ReconcileOutcome | undefined>;
  dispose(): void;
  /** Replacing a superseded reconcile's scope never aborts it — the backend answers that one 409.
   *  Call before the reconcile's first await, not just before the PUT: a launch has an earlier
   *  phase that must honour a backend going away too. */
  arm(): { signal: AbortSignal; abandoned: () => boolean };
  /** Cancel whatever reconcile is armed without touching future `request()`/`flush()` calls; a
   *  later relaunch still finds this object able to serve them. */
  abandon(): void;
}

function createAbortScope(): { arm: () => { signal: AbortSignal; abandoned: () => boolean }; abandon: () => void } {
  let armed: AbortController | undefined;
  return {
    arm: () => {
      const controller = new AbortController();
      armed = controller;
      return {
        signal: controller.signal,
        abandoned: () => controller.signal.aborted,
      };
    },
    abandon: () => {
      armed?.abort();
      armed = undefined;
    },
  };
}

// Every caller of `schedule()` gets back the outcome of the run it caused; `queued` is one shared
// follow-up, and that sharing is the coalescing.
function createRunScheduler(
  run: () => Promise<ReconcileOutcome | undefined>, isDisposed: () => boolean,
): { schedule: () => Promise<ReconcileOutcome | undefined> } {
  let currentRun: Promise<ReconcileOutcome | undefined> | undefined;
  let queued: { promise: Promise<ReconcileOutcome | undefined>; resolve: (outcome: ReconcileOutcome | undefined) => void } | undefined;

  const beginRun = (): Promise<ReconcileOutcome | undefined> => {
    const p = run();
    currentRun = p;
    void p.then(handleSettled, handleSettled);
    return p;
  };
  // Clearing `currentRun` and promoting the queued arrival happen together in one microtask, so
  // no other call can observe a moment where a queued arrival's need has been forgotten.
  const handleSettled = (): void => {
    currentRun = undefined;
    const owed = queued;
    queued = undefined;
    if (!owed) return;
    if (isDisposed()) { owed.resolve(undefined); return; }
    void beginRun().then(owed.resolve, owed.resolve);
  };

  return {
    schedule: () => {
      if (!currentRun) return beginRun();
      queued ??= (() => {
        let resolve!: (outcome: ReconcileOutcome | undefined) => void;
        const promise = new Promise<ReconcileOutcome | undefined>((res) => { resolve = res; });
        return { promise, resolve };
      })();
      return queued.promise;
    },
  };
}

export function createLoadOrderSync<TPlugin = unknown, TProgress = unknown, TOffer = unknown>(
  deps: LoadOrderSyncDeps<TPlugin, TProgress, TOffer>,
): LoadOrderSync {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const { arm, abandon } = createAbortScope();

  // The reconcile's own sequencing lives in `createReconcileSequencer`; this module coalesces
  // *when* it runs and owns the abort scope, shared so `abandon()` reaches the running reconcile.
  const sequencer = createReconcileSequencer<TPlugin, TProgress, TOffer>({ ...deps, arm });

  const run = async (): Promise<ReconcileOutcome | undefined> => {
    let outcome: ReconcileOutcome | undefined;
    try {
      await deps.withProgress(async () => { outcome = await sequencer.reconcile(); });
    } catch (e) {
      // The sequencer's own steps report their failures (ADR-0026's explicit-action tier lives
      // there); this is the backstop so a throw can never wedge every request queued after it.
      deps.log(`[loadOrderSync] sending the load order snapshot threw: ${e instanceof Error ? e.message : String(e)}`);
    }
    return outcome;
  };

  const { schedule } = createRunScheduler(run, () => disposed);

  return {
    request() {
      if (disposed) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = undefined; void schedule(); }, deps.debounceMs);
    },
    flush() {
      if (disposed) return Promise.resolve(undefined);
      // Cancels a debounced request's own timer — its need is folded into whatever `schedule()`
      // returns below, the same as any other arrival would fold in.
      if (timer) { clearTimeout(timer); timer = undefined; }
      // `schedule()` already returns the promise for the run that answers an arrival right now,
      // so this caller gets that run's own outcome, never a run beyond it.
      return schedule();
    },
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
    arm,
    abandon,
  };
}

/** What a caller branches on once a reconcile settles. */
export type ReconcileOutcome = 'reconciled' | 'no-game-directory' | 'failed' | 'abandoned';

/** A tagged union matching `EditingController.LoadOrderOutcome`: `failed` and `abandoned` are
 *  nothing-more-to-say endings, not a `reconciled` with empty arrays. */
export type PutLoadOrderResult<TOffer> =
  | { outcome: 'reconciled'; failures: LoadFailure[]; crashRepairOffers: TOffer[] }
  | { outcome: 'failed' }
  | { outcome: 'abandoned' };

export interface LoadFailure {
  name?: string | null;
  reason?: string | null;
}

/** The steps of a reconcile, each injected opaque enough that this file imports nothing. Generic
 *  rather than `unknown`-typed so the composition root's wiring stays fully typed — a type
 *  parameter carries the shape without carrying the import. */
export interface ReconcileStepDeps<TPlugin = unknown, TProgress = unknown, TOffer = unknown> {
  arm: () => { signal: AbortSignal; abandoned: () => boolean };
  /** The Plugins view's own step narration (`TreeView.message`) — cleared by whichever progress
   *  wrapper the caller runs this under, never by this sequencer itself. */
  say: (msg: string | undefined) => void;
  logInfo: (msg: string) => void;
  /** Surfaces the failure; this sequencer only needs the outcome, not how it is shown. */
  notifyNoGameDirectory: () => void;
  resolveGameDirectory: () => Promise<{ dataFolder: string } | undefined>;
  /** Every physical plugin copy, opaque — the only thing this sequencer does with the result is
   *  read its length (for the log line) and hand it whole to `putLoadOrder`. */
  buildSnapshot: (dataFolder: string) => Promise<TPlugin[]>;
  /** Fresh per reconcile — a progressive reconcile's own ticks (`onProgress`) and the final
   *  `totalPlugins` `applyReconciled` logs against, from the same running state. */
  makeProgressHandler: () => { onProgress: (status: TProgress) => void; lastTotalPlugins: () => number };
  putLoadOrder: (
    plugins: TPlugin[], dataFolder: string, signal: AbortSignal, onProgress: (status: TProgress) => void,
  ) => Promise<PutLoadOrderResult<TOffer>>;
  syncFilterState: () => Promise<void>;
  /** The completed reconcile's whole hand-off to the tree — everything `GET /plugins` answers,
   *  bundled, so there is never a moment a caller could apply one part of it without the rest. */
  applyReconciled: (failures: LoadFailure[], totalPlugins: number) => Promise<void>;
  presentCrashRepairOffers: (offers: TOffer[]) => Promise<void>;
}

export interface ReconcileSequencer {
  reconcile(): Promise<ReconcileOutcome>;
}

export function createReconcileSequencer<TPlugin = unknown, TProgress = unknown, TOffer = unknown>(
  deps: ReconcileStepDeps<TPlugin, TProgress, TOffer>,
): ReconcileSequencer {
  const reconcileOnce = async (): Promise<ReconcileOutcome> => {
    const { signal, abandoned } = deps.arm();
    const treeProgress = deps.makeProgressHandler();
    const gd = await deps.resolveGameDirectory();
    if (abandoned()) {
      deps.logInfo('[loadOrderSync] the reconcile was abandoned before it landed; leaving the closed view alone');
      return 'abandoned';
    }
    if (!gd) {
      deps.notifyNoGameDirectory();
      return 'no-game-directory';
    }
    deps.say('Building the load order snapshot…');
    const plugins = await deps.buildSnapshot(gd.dataFolder);
    if (abandoned()) {
      deps.logInfo('[loadOrderSync] the reconcile was abandoned before it landed; leaving the closed view alone');
      return 'abandoned';
    }
    // The PUT is one blocking call that opens and indexes every copy new to the load order — the
    // slow part on a cold start, SQL-only otherwise. The subscribed status takes over from here.
    deps.logInfo(`[loadOrderSync] sending the load order snapshot (${plugins.length} plugin copies)`);
    const result = await deps.putLoadOrder(plugins, gd.dataFolder, signal, treeProgress.onProgress);
    // A deliberately abandoned reconcile leaves *silently*: nothing to surface (putLoadOrder
    // logged it) and nothing to tear down — the newer snapshot owns the load order now.
    if (result.outcome === 'abandoned') {
      deps.logInfo('[loadOrderSync] the load order snapshot was abandoned; leaving the one that replaced it alone');
      return 'abandoned';
    }
    // ADR-0044: a failed PUT tore nothing down — the backend still holds whatever it held — so
    // the view stays as it is, the error already surfaced (ADR-0026 "explicit action failed").
    if (result.outcome === 'failed') return 'failed';
    await deps.syncFilterState();
    await deps.applyReconciled(result.failures, treeProgress.lastTotalPlugins());
    // Awaited and sequential — one native modal at a time. Declining clears nothing, so the offer
    // re-appears at the next reconcile by construction.
    if (result.crashRepairOffers.length > 0) {
      deps.logInfo(`[loadOrderSync] ${result.crashRepairOffers.length} crash-repair offer(s) to present`);
      await deps.presentCrashRepairOffers(result.crashRepairOffers);
    }
    deps.logInfo('[loadOrderSync] load order reconciled');
    return 'reconciled';
  };

  // No serialization here on purpose: the sole caller already invokes `reconcile()` one at a
  // time. A second, concurrent caller would have to bring its own.
  return { reconcile: reconcileOnce };
}

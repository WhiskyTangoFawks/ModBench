/** ADR-0044: the one path by which the Plugin load order reaches Editing — "recompute the
 *  snapshot, PUT it", coalesced. Every trigger (activation, a profile switch, a `modlist.txt` or
 *  `plugins.txt` write, an install or uninstall, a checkbox toggle, a drag reorder) calls
 *  `request()`; a burst of them becomes one snapshot, and a request that arrives while a PUT is in
 *  flight becomes exactly one more PUT after it, never a race of two.
 *
 *  Lives at the composition root and imports from neither bounded context (the same rule
 *  `PluginsTreeComposite` and `nameFilter` keep — `src/test/contextBoundary.test.ts`): what a
 *  snapshot *is* and how it is *sent* are both injected, so this module knows only that there is
 *  a thing to recompute and a place to send it. */
export interface LoadOrderSyncDeps {
  /** Whether Editing is there to receive a snapshot at all. Mod Management works with no backend
   *  running (root CLAUDE.md), which is the ordinary case, not a failure — so a request with no
   *  receiver is dropped silently rather than surfacing as a doomed call. */
  isReceiving: () => boolean;
  /** Recompute the snapshot and send it. Its own failures are its own to report; this module only
   *  needs it to settle. */
  send: () => Promise<void>;
  /** How long to wait for a burst to finish before sending. Two watchers can fire for one
   *  mod-level change, and a drag reorder rewrites plugins.txt once per drop — none of those
   *  deserve a PUT each. */
  debounceMs: number;
  log: (msg: string) => void;
}

export interface LoadOrderSync {
  /** Something that feeds the load order changed: send a snapshot soon, coalesced with any other
   *  request that lands in the same window. */
  request(): void;
  /** Send now, waiting for any in-flight send first — the activation path, which wants the
   *  snapshot's outcome rather than a promise that one will happen. Any request queued behind the
   *  in-flight send is folded into this one. */
  flush(): Promise<void>;
  dispose(): void;
  /** ADR-0035 amending ADR-0018: does this held plugin (keyed exactly as last set — callers
   *  lowercase before both `setMatches` and this, same as the module-level map this replaced)
   *  own at least one record the currently active record filter matches. `undefined` reads as
   *  "matches" everywhere it's consulted — the composite's own safe default for "never fetched,
   *  or no filter active" — which is also what a never-`setMatches`-called or since-cleared
   *  module answers for any key. */
  matches(file: string): boolean | undefined;
  /** The one owner of the map `matches` reads. A pure assignment — no normalization, no
   *  defaulting, no notification of its own — because every caller (a completed reconcile,
   *  `EditingController.setFilter`/`clearFilter`, mEdit closing, a dead backend) already computed
   *  or decided the map it hands over; this only ever stores it. `undefined` clears it back to
   *  "matches everywhere", the same value the property itself takes when nothing has ever landed. */
  setMatches(map: Map<string, boolean> | undefined): void;
  /** Arms a fresh cancellation scope for one reconcile, replacing whatever scope a previous
   *  reconcile armed — a superseded reconcile does not need aborting, since the backend answers
   *  it 409 (so arming again never aborts the scope it replaces, only stops `abandon()` from
   *  reaching it). Call before the first await of the reconcile's own sequencing, not just before
   *  the PUT: a launch has an earlier phase (bring the backend up) that must honour Close mEdit
   *  too. */
  arm(): { signal: AbortSignal; abandoned: () => boolean };
  /** Cancel whatever reconcile is currently armed — Close mEdit's own gesture — without touching
   *  future `request()`/`flush()` calls; a later Launch mEdit still finds this object able to
   *  serve them. A silent no-op if nothing is armed, or if the armed reconcile already finished. */
  abandon(): void;
}

export function createLoadOrderSync(deps: LoadOrderSyncDeps): LoadOrderSync {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  let pending = false;
  let disposed = false;
  let matchMap: Map<string, boolean> | undefined;
  let armed: AbortController | undefined;

  const run = async (): Promise<void> => {
    if (!deps.isReceiving()) {
      deps.log('[loadOrderSync] no receiver for the load order snapshot; dropping the request');
      return;
    }
    try {
      await deps.send();
    } catch (e) {
      // `send` reports its own failures (ADR-0026's explicit-action tier lives there); this is
      // the backstop so a throw can never wedge every request queued after it.
      deps.log(`[loadOrderSync] sending the load order snapshot threw: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // One sender at a time. A request that lands mid-send sets `pending`, and the send loop
  // re-runs once — with a fresh snapshot, so whatever landed mid-flight is sent whole rather than
  // as a stale copy the in-flight send already missed.
  const kick = (): Promise<void> => {
    if (inFlight) { pending = true; return inFlight; }
    inFlight = (async () => {
      do {
        pending = false;
        await run();
      } while (pending && !disposed);
      inFlight = undefined;
    })();
    return inFlight;
  };

  return {
    request() {
      if (disposed) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = undefined; void kick(); }, deps.debounceMs);
    },
    async flush() {
      if (disposed) return;
      if (timer) { clearTimeout(timer); timer = undefined; }
      // A pending timer's request is folded into this send: it asked for the same thing.
      pending = false;
      if (inFlight) {
        pending = true;
        await inFlight;
        return;
      }
      await kick();
    },
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
    matches(file) {
      return matchMap?.get(file);
    },
    setMatches(map) {
      matchMap = map;
    },
    arm() {
      const controller = new AbortController();
      armed = controller;
      return {
        signal: controller.signal,
        abandoned: () => controller.signal.aborted,
      };
    },
    abandon() {
      armed?.abort();
      armed = undefined;
    },
  };
}

/** One completed reconcile's shape — the branch every caller of `createReconcileSequencer` cares
 *  about, whether it wants to keep polling for progress (Launch mEdit exits to Loadout with no
 *  game directory) or does nothing more either way (the coalesced sync). */
export type ReconcileOutcome = 'reconciled' | 'no-game-directory' | 'failed' | 'abandoned';

/** A load-order PUT's own result — the outcome and, when reconciled, what to report and hand to
 *  the tree. `failures`/`crashRepairOffers` are held opaque (`unknown[]`/structural failure
 *  entries): this module forwards them to `applyReconciled`/`presentCrashRepairOffers` without
 *  ever needing to know what a plugin or a crash-repair offer *is*. */
export interface PutLoadOrderResult {
  outcome: 'reconciled' | 'abandoned' | 'failed';
  failures: LoadFailure[];
  crashRepairOffers: unknown[];
}

export interface LoadFailure {
  name?: string | null;
  reason?: string | null;
}

/** ADR-0044: the sequencing every reconcile follows — recompute the snapshot, PUT it, hand the
 *  backend's answer to the tree — as steps this module can call without knowing what a snapshot,
 *  a game directory or a tree *is*. Each step is injected exactly opaque enough to keep this file
 *  importing nothing (`src/test/contextBoundary.test.ts`): building a snapshot, sending it and
 *  applying its answer are all closures the composition root builds over Mod Management's and
 *  Editing's own types. */
export interface ReconcileStepDeps {
  /** Arms this reconcile's own cancellation scope — `LoadOrderSync.arm()`, threaded in so a
   *  reconcile built through `createLoadOrderSync` and one built standalone (tests) share the
   *  identical contract. */
  arm: () => { signal: AbortSignal; abandoned: () => boolean };
  /** The Plugins view's own step narration (`TreeView.message`) — cleared by whichever progress
   *  wrapper the caller runs this under, never by this sequencer itself. */
  say: (msg: string | undefined) => void;
  logInfo: (msg: string) => void;
  /** No game directory means nothing to build a snapshot from — surfaces the toast; this
   *  sequencer only needs to know the outcome, not how the failure is shown. */
  notifyNoGameDirectory: () => void;
  resolveGameDirectory: () => Promise<{ dataFolder: string } | undefined>;
  /** Every physical plugin copy, opaque — the only thing this sequencer does with the result is
   *  read its length (for the log line) and hand it whole to `putLoadOrder`. */
  buildSnapshot: (dataFolder: string) => Promise<unknown[]>;
  /** Fresh per reconcile — a progressive reconcile's own ticks (`onProgress`) and the final
   *  `totalPlugins` `applyReconciled` logs against, from the same running state. */
  makeProgressHandler: () => { onProgress: (status: unknown) => void; lastTotalPlugins: () => number };
  putLoadOrder: (
    plugins: unknown[], dataFolder: string, signal: AbortSignal, onProgress: (status: unknown) => void,
  ) => Promise<PutLoadOrderResult>;
  syncFilterState: () => Promise<void>;
  /** The completed reconcile's whole hand-off to the tree — everything `GET /plugins` answers,
   *  bundled, so there is never a moment a caller could apply one part of it without the rest. */
  applyReconciled: (failures: LoadFailure[], totalPlugins: number) => Promise<void>;
  presentCrashRepairOffers: (offers: unknown[]) => Promise<void>;
}

export interface ReconcileSequencer {
  reconcile(): Promise<ReconcileOutcome>;
}

/** ADR-0044: one reconcile, exactly as `extension.ts`'s own `makeReconcileLoadOrder` sequenced it
 *  — this is that function's body, ported statement-for-statement, now driven by injected steps
 *  instead of calling Mod Management/Editing directly. */
export function createReconcileSequencer(deps: ReconcileStepDeps): ReconcileSequencer {
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
    // slow part on a cold start, SQL-only otherwise. The polled status (treeProgress.onProgress)
    // takes over from here, applying chevrons/failures to the tree as they land.
    deps.logInfo(`[loadOrderSync] sending the load order snapshot (${plugins.length} plugin copies)`);
    const result = await deps.putLoadOrder(plugins, gd.dataFolder, signal, treeProgress.onProgress);
    // A reconcile that was deliberately abandoned — superseded by a newer snapshot, or aborted
    // because the user closed mEdit — leaves *silently*. Nothing to surface (putLoadOrder only
    // logged it) and nothing to tear down: the newer snapshot owns the load order now.
    if (result.outcome === 'abandoned') {
      deps.logInfo('[loadOrderSync] the load order snapshot was abandoned; leaving the one that replaced it alone');
      return 'abandoned';
    }
    // ADR-0044: a failed PUT tore nothing down — the backend still holds whatever it held — so
    // the view stays as it is, the error already surfaced (ADR-0026 "explicit action failed").
    if (result.outcome === 'failed') return 'failed';
    await deps.syncFilterState();
    await deps.applyReconciled(result.failures, treeProgress.lastTotalPlugins());
    // The loud detect-and-offer, run once per reconcile — after the tree has already settled,
    // awaited and sequential (one native modal at a time; see crashRepairOffer.ts's own doc
    // comment). Declining leaves the marker/missing binary exactly as it is; nothing here clears
    // it, so the offer re-appears at the next reconcile by construction.
    if (result.crashRepairOffers.length > 0) {
      deps.logInfo(`[loadOrderSync] ${result.crashRepairOffers.length} crash-repair offer(s) to present`);
      await deps.presentCrashRepairOffers(result.crashRepairOffers);
    }
    deps.logInfo('[loadOrderSync] load order reconciled');
    return 'reconciled';
  };

  // One reconcile at a time, whoever asks. Launch mEdit and the coalesced sync both come through
  // here, and a watcher can fire while a launch's own PUT is still in flight — two concurrent
  // PUTs would have the backend cancel the first (409) and the launch report an abandonment for a
  // snapshot the sync then owned. Tail-chained so a caller reaching this while one is still
  // running gets its own freshly-sequenced run queued after it, never a concurrent one racing it;
  // chained past both outcomes so one throw never wedges the next.
  let tail: Promise<unknown> = Promise.resolve();
  const reconcile = (): Promise<ReconcileOutcome> => {
    const run = tail.then(reconcileOnce);
    tail = run.then(() => undefined, () => undefined);
    return run;
  };

  return { reconcile };
}

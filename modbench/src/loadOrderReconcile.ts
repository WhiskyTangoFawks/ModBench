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

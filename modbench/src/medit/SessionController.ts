import type { ApiClient, SessionStatus } from './ApiClient';
import { errorText } from './ApiClient';
import type { PluginRepository } from './PluginRepository';
import { reportSkippedPlugins } from './sessionFailures';

export interface SessionControllerDeps {
  client: ApiClient;
  repository: PluginRepository;
  refreshTree: () => void;
  setStatusText: (text: string) => void;
  showWarning: (msg: string) => void;
  showError: (msg: string) => void;
  /** #255: `label` names the filter's *source* (a `.sql` filename, or the document it was applied
   *  from) for the Plugins tree's description readout — undefined when it isn't known, which is
   *  the case for a filter read back off the backend at session start. */
  setFilterActive: (active: boolean, sql?: string, label?: string) => void;
  /** #278 / ADR-0035 amending ADR-0018: called whenever the record filter's per-plugin match set
   *  can have changed — after `setFilter` succeeds, and after `clearFilter` — so the caller can
   *  re-fetch and re-publish `PluginMetadata.hasMatchingRecords` to `PluginsTreeComposite`'s
   *  chevron. Symmetric on purpose: a stale `false` surviving a clear would leave a plugin
   *  permanently unexpandable, the mirror image of the bug this ticket exists to kill. Takes no
   *  argument — the same "something changed, go re-derive it" shape as `refreshTree` — because
   *  the fetch and the derivation both belong to the caller, not here. */
  refreshMatchingPlugins: () => void;
  // #308 / ADR-0035: called exactly when a `loadExplicitSession` resolves `{ outcome: 'loaded' }`
  // — see that call site's own comment for why this is the one reliable, already-existing point
  // at which conflicts become computed, and why no poller is added for it.
  notifyConflictsComputed: () => void;
  log?: (msg: string) => void;
}

/** #307 / ADR-0035: how often the in-flight load is asked what it has indexed so far.
 *
 *  500ms matches `BackendManager`'s own `GET /health` cadence — the one in-repo precedent for
 *  polling this backend, which is a better answer than a number picked by feel. Slow enough not
 *  to be a busy loop against a backend that is already working hard, fast enough that chevrons
 *  arrive smoothly rather than in visible lurches. Tuned against a real load order under #313;
 *  this constant is the single dial. */
export const SESSION_STATUS_POLL_INTERVAL_MS = 500;

/** One tick of a running load's own progress — `SessionStatus` exactly as the backend reported
 *  it. Re-exported under its own name because it is this method's callback contract, not merely
 *  a repository return type the caller happens to see. */
export type SessionLoadProgress = SessionStatus;

/** #307: how a load ended. Three outcomes, because there are three, and a caller must respond to
 *  each differently:
 *
 *  - `loaded` — the session is up; `failures` are the plugins it skipped (#277 / ADR-0037 AC7).
 *  - `failed` — the load itself failed, already surfaced (ADR-0026 "explicit action failed").
 *    The backend disposes the previous session before attempting a new one, so this means *no*
 *    session, not a stale one — the caller must tear the view down (#295 AC4).
 *  - `abandoned` — the load was deliberately given up: superseded by another load (409) or
 *    aborted by the user closing the session. **Nothing went wrong**, so there is nothing to
 *    surface, and, crucially, nothing for the caller to tear down: whatever replaced this load
 *    owns the session now, and tearing down would take *its* backend with it.
 *
 *  A tagged union rather than a third sentinel value: `undefined` already had to be documented
 *  everywhere it was read (#295), and a second one would be a rule every call site must remember. */
export type SessionLoadOutcome =
  | { outcome: 'loaded'; failures: { name?: string | null; reason?: string | null }[] }
  | { outcome: 'failed' }
  | { outcome: 'abandoned' };

/** #307: what a caller may pass to observe (and abandon) a load in progress. Deliberately plain
 *  stdlib — `AbortSignal`, not a bespoke token — so this interface still carries no VS Code types
 *  and `openapi-fetch` can forward it straight to `fetch`, cancelling the request itself rather
 *  than leaving it to notice a dead socket. */
export interface SessionLoadOptions {
  /** Called on each poll of `GET /session/status` while the load POST is in flight. Never called
   *  after the load settles. */
  onProgress?: (progress: SessionLoadProgress) => void;
  /** Trips when the user deliberately abandons this load (closing the session). Stops the
   *  polling and aborts the POST itself rather than waiting for a dead socket. */
  signal?: AbortSignal;
}

export class SessionController {
  private readonly log: (msg: string) => void;
  constructor(private readonly deps: SessionControllerDeps) {
    this.log = deps.log ?? (() => {});
  }

  async createPlugin(name: string): Promise<void> {
    const { error, response } = await this.deps.client.POST('/plugins/create', { body: { name } });
    if (!response.ok) {
      const text = errorText(error);
      this.log(`[SessionController] createPlugin failed (${response.status}): ${text}`);
      this.deps.showError(`mEdit: Failed to create plugin — ${text}`);
      return;
    }
    this.deps.refreshTree();
  }

  /** Load the editing session from an ordered { name, path, origin, participates } list built
   *  from the active modlist (POST /session/load-explicit). `gameDirectory` must be the
   *  resolved Data folder — the backend prepends implicit masters from it. `origin` is
   *  required (#269 / ADR-0036, #275) — the caller resolves it before this point; the
   *  backend no longer defaults a missing origin. So is `participates` (#270 / ADR-0035): the
   *  list is every plugins.txt line, and the `*` prefix rides along rather than filtering it.
   *
   *  Resolves with a tagged {@link SessionLoadOutcome}; on `loaded` it carries the load's own
   *  `failures` (#277 / ADR-0037 AC7) — the same data the toast below already consumes, so the
   *  caller (the Plugins tree's session hand-off) can decorate those rows with their reason
   *  instead of re-deriving the fact a second way. */
  async loadExplicitSession(
    plugins: { name: string; path: string; origin: string; participates: boolean }[],
    gameDirectory: string,
    gameRelease = 'Fallout4',
    options: SessionLoadOptions = {},
  ): Promise<SessionLoadOutcome> {
    // #307 / ADR-0035: the POST stays blocking (#274 kept that contract) and the generated
    // openapi-fetch client has no streaming path, so progress is *polled* off GET /session/status
    // alongside the still in-flight POST. Started before the await, stopped in the finally: the
    // poll's whole reason to exist is the window this await covers.
    const stopPolling = this.pollSessionStatus(options);
    let result;
    try {
      result = await this.deps.client.POST('/session/load-explicit', {
        body: { plugins, gameDirectory, gameRelease },
        // #307 AC7: aborts the request itself rather than leaving it to notice a dead socket.
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (e) {
      if (this.wasDeliberatelyAborted(options.signal)) return { outcome: 'abandoned' };
      throw e;
    } finally {
      stopPolling();
    }
    const { data, error, response } = result;
    // #307 AC7: 409 is the backend saying this load was superseded by another load or by
    // unloading the session (SessionEndpoints.SupersededLoad) — a warning there, not an error,
    // and the same here. Surfacing it would toast the user for something they asked for, and
    // treating it as a failure would make the caller tear down the session the *newer* load now
    // owns. Checked before `!response.ok`, which would otherwise swallow it.
    if (response.status === 409) {
      this.log(`[SessionController] loadExplicitSession was superseded (409): ${errorText(error)}`);
      return { outcome: 'abandoned' };
    }
    if (!response.ok) {
      const text = errorText(error);
      this.log(`[SessionController] loadExplicitSession failed (${response.status}): ${text}`);
      this.deps.showError(`mEdit: Failed to load session — ${text}`);
      // #295: the backend's own SessionManager.LoadExplicitCore disposes the previous session
      // unconditionally before attempting the new one, so a failed POST means no session at all,
      // not "loaded with nothing to report" — the caller (makeEnterEditing) must tear the view
      // down, which is what makes this distinct from `loaded` with an empty failure list.
      return { outcome: 'failed' };
    }
    return this.reportLoadedSession(plugins, data?.failures ?? []);
  }

  /** #307 AC7: whether a rejected load POST was the user closing the session rather than a
   *  fault. An abort is the one rejection that is not a failure — the teardown they asked for is
   *  already underway, so there is nothing to report and nothing to tear down. Every other
   *  network-level rejection still propagates to the caller's own handler, as before. */
  private wasDeliberatelyAborted(signal: AbortSignal | undefined): boolean {
    if (!signal?.aborted) return false;
    this.log('[SessionController] loadExplicitSession was aborted — the session was closed while it loaded');
    return true;
  }

  /** The successful load's own reporting: what it skipped, whether it loaded anything that can
   *  actually win a FormKey, and the tree/status refresh. Split out of loadExplicitSession purely
   *  for that method's complexity budget once #307 gave it three outcomes to classify. */
  private reportLoadedSession(
    plugins: { participates: boolean }[],
    failures: { name?: string | null; reason?: string | null }[],
  ): SessionLoadOutcome {
    reportSkippedPlugins(failures, {
      log: (m) => this.log(`[SessionController] ${m}`),
      warn: this.deps.showWarning,
    });
    // Counted, not `plugins.length === 0`: since #270 the list is every plugins.txt line, so a
    // non-empty one can still have nothing enabled. Either way only base-game masters actually
    // load in the game, nothing else can win a FormKey, and the user's mental model ("my mods are
    // loaded") would be silently wrong (ADR-0026 integrity tier).
    if (!plugins.some((p) => p.participates)) {
      this.deps.showWarning(
        'mEdit: The active profile has no enabled plugins — only base-game masters were loaded. ' +
          'Enable plugins in the mod list (or check the profile\'s plugins.txt).',
      );
    }
    this.deps.setStatusText(`$(check) mEdit: Ready (${plugins.length} plugins)`);
    this.deps.refreshTree();
    // #308 / ADR-0035: the backend only answers this POST after the winner sweep (#274), so
    // reaching here *is* "conflicts are now computed" — reusing that existing fact rather than
    // adding a second poller or a second notion of "is the session settled" (the ticket's own
    // Shape section). Record panels open mid-load are listening for this to refetch their own
    // comparison instead of staying on the partial one they opened against.
    //
    // FORWARD COUPLING (#97): this fires only on the *load-completing* false→true transition.
    // `conflictsComputed` is a separate field from session `state` precisely because ADR-0035's
    // live mutations (reorder, enable, disable) will re-sweep a *Ready* session and can leave it
    // stale again — true→false, the opposite direction. Nothing here observes that transition.
    // Whoever wires live mutation owes the record panel the same notification on the way *out* of
    // settled, or this banner will silently stop working the moment #97 ships.
    this.deps.notifyConflictsComputed();
    return { outcome: 'loaded', failures };
  }

  /** #307: poll `GET /session/status` until the caller stops us, reporting each answer. Returns
   *  the stop function; a load with no `onProgress` polls nothing at all.
   *
   *  Self-rescheduling `setTimeout` rather than `setInterval`: a slow status read must not be
   *  able to stack up ticks behind itself against a backend that is already indexing. The first
   *  tick is one interval in, not immediate — at t=0 the backend has not published anything yet,
   *  so an immediate poll would only ever report an empty set. */
  private pollSessionStatus(options: SessionLoadOptions): () => void {
    const { onProgress, signal } = options;
    if (!onProgress) return () => {};
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const done = () => stopped || (signal?.aborted ?? false);
    const tick = async () => {
      try {
        const status = await this.deps.repository.getSessionStatus();
        // Re-checked after the await: the load can settle (or be abandoned) while this read is
        // in flight, and a tick landing after that would report a session nobody is waiting on.
        if (done()) return;
        onProgress(status);
      } catch (e) {
        // ADR-0026 background/recoverable tier: a poll is frequent and non-essential, so a blip
        // gets a log line and the next tick — never a toast, and never a failed load. The load
        // POST itself is the completion signal and is unaffected by this.
        this.log(`[SessionController] GET /session/status poll failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (!done()) timer = setTimeout(() => { void tick(); }, SESSION_STATUS_POLL_INTERVAL_MS);
    };
    timer = setTimeout(() => { void tick(); }, SESSION_STATUS_POLL_INTERVAL_MS);
    return () => { stopped = true; clearTimeout(timer); };
  }

  async setFilter(sql: string, label?: string): Promise<boolean> {
    const error = await this.deps.repository.setFilter(sql);
    if (error) {
      this.deps.showError(`mEdit: Filter failed — ${error}`);
      return false;
    }
    this.deps.setFilterActive(true, sql, label);
    this.deps.refreshTree();
    this.deps.refreshMatchingPlugins();
    return true;
  }

  async clearFilter(): Promise<void> {
    await this.deps.repository.clearFilter();
    this.deps.setFilterActive(false);
    this.deps.refreshTree();
    this.deps.refreshMatchingPlugins();
  }

  async syncFilterState(): Promise<void> {
    let sql: string | null;
    try {
      sql = await this.deps.repository.getActiveFilter();
    } catch (e) {
      this.log(`[SessionController] syncFilterState failed: ${e instanceof Error ? e.message : String(e)}`);
      this.deps.showWarning(
        `mEdit: Could not read the active filter — treating the filter as inactive. ${e instanceof Error ? e.message : String(e)}`,
      );
      this.deps.setFilterActive(false);
      return;
    }
    this.deps.setFilterActive(sql !== null, sql ?? undefined, undefined);
  }

  /** #279 / ADR-0035 § Live mutation: re-read one plugin from the copy its name resolves to now.
   *  The path and origin come from the caller — Mod Management resolved them; the backend cannot
   *  and must not.
   *
   *  Returns whether it happened. A failure is ADR-0026's "explicit action failed" tier (the user
   *  ran a command), so it is notified as well as logged, and nothing is refreshed: the session is
   *  exactly as it was, staged edits included. A 409 here is the ordinary "a load is still in
   *  flight" answer, which is worth telling the user precisely because retrying will work. */
  async rereadPlugin(plugin: string, path: string, origin: string): Promise<boolean> {
    try {
      const { error, response } = await this.deps.client.POST('/plugins/reread', {
        body: { plugin, path, origin },
      });
      if (!response.ok) {
        const text = errorText(error);
        this.log(`[SessionController] rereadPlugin(${plugin}) failed (${response.status}): ${text}`);
        this.deps.showError(`mEdit: Could not re-read "${plugin}" — ${text}`);
        return false;
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.log(`[SessionController] rereadPlugin(${plugin}) threw: ${message}`);
      this.deps.showError(`mEdit: Could not re-read "${plugin}" — ${message}`);
      return false;
    }
    // The plugin's records were replaced and winners re-swept, so every cached page for it and
    // every conflict badge in the tree is stale.
    this.deps.refreshTree();
    return true;
  }

}

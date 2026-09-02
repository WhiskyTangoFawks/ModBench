import type { components } from './generated/api';
import type {
  ApiClient, CompileResult, LoadOrderStatus, TrackStatus, ExternalChangeActionResult, RebaseResult,
  CrashRepairOffer,
} from './ApiClient';
import { errorText } from './ApiClient';
import type { PluginRepository } from './PluginRepository';
import { reportSkippedPlugins } from './pluginFailures';

export interface EditingControllerDeps {
  client: ApiClient;
  repository: PluginRepository;
  refreshTree: () => void;
  setStatusText: (text: string) => void;
  showWarning: (msg: string) => void;
  showError: (msg: string) => void;
  /** `label` names the filter's *source* (a `.sql` filename, or the document it was applied
   *  from) for the Plugins tree's description readout — undefined when it isn't known, which is
   *  the case for a filter read back off the backend when it comes up. */
  setFilterActive: (active: boolean, sql?: string, label?: string) => void;
  /** ADR-0035 amending ADR-0018: called whenever the record filter's per-plugin match set
   *  can have changed — after `setFilter` succeeds, and after `clearFilter` — so the caller can
   *  re-fetch and re-publish `PluginMetadata.hasMatchingRecords` to `PluginsTreeComposite`'s
   *  chevron. Symmetric on purpose: a stale `false` surviving a clear would leave a plugin
   *  permanently unexpandable. Takes no
   *  argument — the same "something changed, go re-derive it" shape as `refreshTree` — because
   *  the fetch and the derivation both belong to the caller, not here. */
  refreshMatchingPlugins: () => void;
  // ADR-0035: called exactly when a `putLoadOrder` resolves `{ outcome: 'reconciled' }` —
  // see that call site's own comment for why this is the one reliable, already-existing point at
  // which conflicts become computed, and why no poller is added for it. ADR-0044: every reconcile
  // that changes anything re-sweeps, so this fires on every reconcile — a reorder, an enable, a
  // disable — not only the first.
  notifyConflictsComputed: () => void;
  log?: (msg: string) => void;
}

/** #290: the ProblemDetails extension `WriteEndpointMapping.Refusal` rides beside `detail` for
 *  the one create-time refusal a header edit can resolve — `undefined` for every other refusal
 *  (including a transport error, whose `error` never has this shape), so `mutate`'s own
 *  `onEslContradiction` branch can stay a single truthy check. */
function eslContradictionMessage(error: unknown): string | undefined {
  const problem = error as { eslContradiction?: boolean; detail?: string } | undefined;
  return problem?.eslContradiction ? (problem.detail ?? errorText(error)) : undefined;
}

/** ADR-0035: how often the in-flight reconcile is asked what it has indexed so far.
 *
 *  500ms matches `BackendManager`'s own `GET /health` cadence — the one in-repo precedent for
 *  polling this backend, which is a better answer than a number picked by feel. Slow enough not
 *  to be a busy loop against a backend that is already working hard, fast enough that chevrons
 *  arrive smoothly rather than in visible lurches. Tuned against a real load order;
 *  this constant is the single dial. */
export const STATUS_POLL_INTERVAL_MS = 500;

/** One tick of a running reconcile's own progress — `LoadOrderStatus` exactly as the backend
 *  reported it. Re-exported under its own name because it is this method's callback contract, not
 *  merely a repository return type the caller happens to see. */
export type LoadOrderProgress = LoadOrderStatus;

/** ADR-0044: one physical plugin copy of the snapshot, as Mod Management computed it — the slot
 *  its name holds in plugins.txt (null when no line names it), the line's `*` prefix, and whether
 *  the Mod override order resolves the name to this copy. Structurally `modmanager/loadOrderSnapshot.ts`'s
 *  `LoadOrderPlugin`, restated here rather than imported: this module belongs to Editing and
 *  imports nothing from Mod Management. */
export interface LoadOrderPluginInput {
  name: string;
  path: string;
  origin: string;
  slot: number | null;
  enabled: boolean;
  winning: boolean;
}

/** How a reconcile ended. Three outcomes, because there are three, and a caller must respond
 *  to each differently:
 *
 *  - `reconciled` — the load order is held; `failures` are the copies it could not open or index
 *    (ADR-0037 AC7, each a row in an error state — ADR-0044); `crashRepairOffers` are
 *    the loud detect-and-offer targets — a plugin this same reconcile found with an
 *    interrupted compile or an unreadable binary, riding the response the same way `failures`
 *    already does.
 *  - `failed` — the PUT itself failed, already surfaced (ADR-0026 "explicit action failed").
 *    ADR-0044: nothing is torn down on the backend — whatever it held before is still held — so
 *    the caller leaves the view as it is rather than exiting to Loadout.
 *  - `abandoned` — the reconcile was deliberately given up: superseded by a newer snapshot (409)
 *    or aborted by the user closing mEdit. **Nothing went wrong**, so there is nothing to surface,
 *    and nothing for the caller to tear down: the newer snapshot owns the load order now.
 *
 *  A tagged union rather than a third sentinel value: `undefined` already had to be documented
 *  everywhere it was read, and a second one would be a rule every call site must remember. */
export type LoadOrderOutcome =
  | { outcome: 'reconciled'; failures: components['schemas']['PluginLoadFailure'][]; crashRepairOffers: CrashRepairOffer[] }
  | { outcome: 'failed' }
  | { outcome: 'abandoned' };

/** What a caller may pass to observe (and abandon) a reconcile in progress. Deliberately
 *  plain stdlib — `AbortSignal`, not a bespoke token — so this interface still carries no VS Code
 *  types and `openapi-fetch` can forward it straight to `fetch`, cancelling the request itself
 *  rather than leaving it to notice a dead socket. */
export interface LoadOrderOptions {
  /** Called on each poll of `GET /load-order/status` while the PUT is in flight. Never called
   *  after the reconcile settles. */
  onProgress?: (progress: LoadOrderProgress) => void;
  /** Trips when the user deliberately abandons this reconcile (closing mEdit). Stops the polling
   *  and aborts the PUT itself rather than waiting for a dead socket. */
  signal?: AbortSignal;
}

/** Editing's HTTP orchestration — every gesture the extension makes against the backend, with
 *  no VS Code types in its interface (VS Code chat tool handlers call it directly — ADR-0012). */
export class EditingController {
  private readonly log: (msg: string) => void;
  constructor(private readonly deps: EditingControllerDeps) {
    this.log = deps.log ?? (() => {});
  }

  /**
   * ADR-0041: creates a plugin at a caller-resolved destination (path/origin — Mod
   * Management's destination QuickPick: overwrite/, an existing mod, or a freshly installed mod
   * folder) and Tracks it if untracked, the same division of labour `track` already follows. Returns the created plugin's own name (never assumed to equal the requested
   * one) on success, undefined on failure. Deliberately does not refresh the tree — that only
   * makes sense once the caller's own `plugins.txt` append has also landed (the extension's
   * composition root), so a partially-done create is never shown as done.
   */
  async createPlugin(name: string, path: string, origin: string): Promise<{ name: string } | undefined> {
    const { error, response, data } = await this.deps.client.POST('/plugins/create', { body: { name, path, origin } });
    if (!response.ok) {
      const text = errorText(error);
      this.log(`[EditingController] createPlugin failed (${response.status}): ${text}`);
      this.deps.showError(`mEdit: Failed to create plugin — ${text}`);
      return undefined;
    }
    return { name: data?.name ?? name };
  }

  /** ADR-0044: send Mod Management's snapshot — every physical plugin copy in the instance, each
   *  with its slot, `*` prefix and winning flag — as `PUT /load-order`, and let Editing reconcile
   *  it against what it holds. The one way the load order ever reaches Editing: activation, a
   *  profile switch, a modlist/plugins.txt write, an install, a checkbox toggle and a drag reorder
   *  all come through here. `gameDirectory` must be the resolved Data folder — the backend
   *  prepends implicit masters from it. `instanceRoot` is the MO2 instance the mod folders belong
   *  to: the backend keys its persistent index on it (ADR-0001), because `origin` is a mod
   *  folder *name* and so is unique only within one instance.
   *
   *  Resolves with a tagged {@link LoadOrderOutcome}; on `reconciled` it carries the reconcile's
   *  own `failures` (ADR-0037 AC7) — the same data the toast below already consumes, so
   *  the caller (the Plugins tree's hand-off) can decorate those rows with their reason instead of
   *  re-deriving the fact a second way. */
  async putLoadOrder(
    plugins: LoadOrderPluginInput[],
    gameDirectory: string,
    instanceRoot: string,
    gameRelease = 'Fallout4',
    options: LoadOrderOptions = {},
  ): Promise<LoadOrderOutcome> {
    // ADR-0035: the PUT stays blocking and the generated
    // openapi-fetch client has no streaming path, so progress is *polled* off GET /load-order/status
    // alongside the still in-flight PUT. Started before the await, stopped in the finally: the
    // poll's whole reason to exist is the window this await covers.
    const stopPolling = this.pollStatus(
      'GET /load-order/status', () => this.deps.repository.getLoadOrderStatus(), options.onProgress, options.signal,
    );
    let result;
    try {
      result = await this.deps.client.PUT('/load-order', {
        body: { plugins, gameDirectory, instanceRoot, gameRelease },
        // Aborts the request itself rather than leaving it to notice a dead socket.
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (e) {
      if (this.wasDeliberatelyAborted(options.signal)) return { outcome: 'abandoned' };
      throw e;
    } finally {
      stopPolling();
    }
    const { data, error, response } = result;
    // 409 is the backend saying this snapshot was superseded by a newer one or by
    // closing (LoadOrderEndpoints.SupersededReconcile) — a warning there, not an error, and the
    // same here. Surfacing it would toast the user for something they asked for, and treating it
    // as a failure would make the caller act on a load order the *newer* snapshot now owns.
    // Checked before `!response.ok`, which would otherwise swallow it.
    if (response.status === 409) {
      this.log(`[EditingController] putLoadOrder was superseded (409): ${errorText(error)}`);
      return { outcome: 'abandoned' };
    }
    if (!response.ok) {
      const text = errorText(error);
      this.log(`[EditingController] putLoadOrder failed (${response.status}): ${text}`);
      this.deps.showError(`mEdit: Failed to send the load order — ${text}`);
      return { outcome: 'failed' };
    }
    // One narrowing rather than four: `data` is undefined only on a non-ok response, already
    // returned above. Both lists are non-nullable on the wire (#627) — there is nothing left to
    // coalesce per field.
    const reconciled = data ?? { failures: [], crashRepairOffers: [] };
    return this.reportReconciled(plugins, reconciled.failures, reconciled.crashRepairOffers);
  }

  /** Whether a rejected PUT was the user closing mEdit rather than a fault. An abort is
   *  the one rejection that is not a failure — the teardown they asked for is already underway,
   *  so there is nothing to report and nothing to tear down. Every other network-level rejection
   *  still propagates to the caller's own handler. */
  private wasDeliberatelyAborted(signal: AbortSignal | undefined): boolean {
    if (!signal?.aborted) return false;
    this.log('[EditingController] putLoadOrder was aborted — mEdit was closed while it reconciled');
    return true;
  }

  /** The successful reconcile's own reporting: what it could not open, whether it holds anything
   *  that can actually win a FormKey, and the tree/status refresh. Split out of putLoadOrder purely
   *  for that method's complexity budget. */
  private reportReconciled(
    plugins: LoadOrderPluginInput[],
    failures: components['schemas']['PluginLoadFailure'][],
    crashRepairOffers: CrashRepairOffer[],
  ): LoadOrderOutcome {
    reportSkippedPlugins(failures, {
      log: (m) => this.log(`[EditingController] ${m}`),
      warn: this.deps.showWarning,
    });
    // ADR-0044: participation is derived — enabled AND winning AND listed — and the snapshot is
    // every copy, so a non-empty one can still have nothing that participates. Either way only
    // base-game masters actually load in the game, nothing else can win a FormKey, and the user's
    // mental model ("my mods are loaded") would be silently wrong (ADR-0026 integrity tier).
    if (!plugins.some((p) => p.enabled && p.winning && p.slot !== null)) {
      this.deps.showWarning(
        'mEdit: The active profile has no enabled plugins — only base-game masters are held. ' +
          'Enable plugins in the mod list (or check the profile\'s plugins.txt).',
      );
    }
    this.deps.setStatusText(`$(check) mEdit: Ready (${plugins.length} plugin copies)`);
    this.deps.refreshTree();
    // ADR-0035: the backend only answers this PUT after the winner sweep, so
    // reaching here *is* "conflicts are now computed" — reusing that existing fact rather than
    // adding a second poller or a second notion of "is the load order settled". Record panels open
    // mid-reconcile are listening for this to refetch their own comparison instead of staying on
    // the partial one they opened against. ADR-0044: every reconcile that changed anything
    // re-swept, so this fires on every one.
    this.deps.notifyConflictsComputed();
    return { outcome: 'reconciled', failures, crashRepairOffers };
  }

  /** Poll `GET /load-order/status` until the caller stops us, reporting each answer. Returns
   *  the stop function; a reconcile with no `onProgress` polls nothing at all.
   *
   *  Self-rescheduling `setTimeout` rather than `setInterval`: a slow status read must not be
   *  able to stack up ticks behind itself against a backend that is already indexing. The first
   *  tick is one interval in, not immediate — at t=0 the backend has not published anything yet,
   *  so an immediate poll would only ever report an empty set. */
  private pollStatus<T>(
    endpoint: string,
    read: () => Promise<T>,
    onProgress: ((status: T) => void) | undefined,
    signal?: AbortSignal,
  ): () => void {
    if (!onProgress) return () => {};
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const done = () => stopped || (signal?.aborted ?? false);
    const tick = async () => {
      try {
        const status = await read();
        // Re-checked after the await: the operation can settle (or be abandoned) while this read
        // is in flight, and a tick landing after that would report progress nobody is waiting on.
        if (done()) return;
        onProgress(status);
      } catch (e) {
        // ADR-0026 background/recoverable tier: a poll is frequent and non-essential, so a blip
        // gets a log line and the next tick — never a toast, and never a failed operation. The
        // blocking request itself is the completion signal and is unaffected by this.
        this.log(`[EditingController] ${endpoint} poll failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (!done()) timer = setTimeout(() => { void tick(); }, STATUS_POLL_INTERVAL_MS);
    };
    timer = setTimeout(() => { void tick(); }, STATUS_POLL_INTERVAL_MS);
    return () => { stopped = true; clearTimeout(timer); };
  }

  /** The one mutation frame every POST-shaped gesture shares: send, surface a failure
   *  (ADR-0026 "explicit action failed" — log + toast, `failMsg` prefixed to the server's own
   *  text), refresh what the success invalidated, map the response. Behavior per method lives in
   *  the spec; the frame never varies.
   *
   *  `refresh: 'both'` re-reads the tree *and* the per-plugin filter matches — the right answer
   *  for anything that lands a working-tree change (ADR-0035 amending ADR-0018: a changed record
   *  can start or stop matching the active filter). A predicate makes that conditional on the
   *  response (typed refusals succeed as HTTP but change nothing).
   *
   *  `onEslContradiction` is #290's escape hatch, opt-in per call site: when the server's
   *  ProblemDetails carries the `eslContradiction` extension (createRecord's own twin of
   *  compile's typed marker) and a caller supplied this, its outcome replaces the ordinary
   *  toast-and-fail — the caller owns the prompt-and-retry (`editorCommands.ts`'s
   *  `offerEslFlagRemoval`, the same one compile already uses), this frame only routes around its
   *  own default when told to. Every other refusal, and every call site that leaves it unset,
   *  behaves exactly as before. */
  private async mutate<T, R>(spec: {
    op: string;
    failMsg: string;
    post: () => Promise<{ data?: T; error?: unknown; response: { ok: boolean; status: number } }>;
    refresh?: 'both' | ((data: T | undefined) => boolean);
    map: (data: T | undefined) => R;
    failure: R;
    onEslContradiction?: (message: string) => Promise<R>;
  }): Promise<R> {
    try {
      const { data, error, response } = await spec.post();
      if (!response.ok) {
        const eslMessage = spec.onEslContradiction && eslContradictionMessage(error);
        if (eslMessage) return spec.onEslContradiction!(eslMessage);
        const text = errorText(error);
        this.log(`[EditingController] ${spec.op} failed (${response.status}): ${text}`);
        this.deps.showError(`${spec.failMsg} — ${text}`);
        return spec.failure;
      }
      if (spec.refresh === 'both' || (typeof spec.refresh === 'function' && spec.refresh(data))) {
        this.deps.refreshTree();
        this.deps.refreshMatchingPlugins();
      }
      return spec.map(data);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.log(`[EditingController] ${spec.op} threw: ${message}`);
      this.deps.showError(`${spec.failMsg} — ${message}`);
      return spec.failure;
    }
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
      this.log(`[EditingController] syncFilterState failed: ${e instanceof Error ? e.message : String(e)}`);
      this.deps.showWarning(
        `mEdit: Could not read the active filter — treating the filter as inactive. ${e instanceof Error ? e.message : String(e)}`,
      );
      this.deps.setFilterActive(false);
      return;
    }
    this.deps.setFilterActive(sql !== null, sql ?? undefined, undefined);
  }

  /** The origin (mod folder identity) the load order names for this plugin — the copy
   *  plugins.txt points at, never a losing copy of the same name (ADR-0044 holds both) — what the
   *  Track command needs to know which mod folder to track, resolved off the same already-fetched
   *  plugin list the tree itself reads, not a stale/current MO2 resolution.
   *  `undefined` when the load order names no plugin of this name — and equally when the backend
   *  isn't running yet (Track/Rebase/compileAtMain, and Save & Compile's own tree-row tier, all
   *  resolve their target through this call first). `PluginRepository.getPlugins()` deliberately
   *  lets a transport failure propagate as-is (its own doc comment); it is caught here — ADR-0026
   *  background/recoverable tier, same posture the poll-failure catches elsewhere in this file —
   *  and degraded to the existing "not found" `undefined`, which every caller already turns into
   *  a clear message. Without the catch, a call before Launch mEdit surfaces as VS Code's own
   *  raw, uncaught "fetch failed" toast instead of this codebase's own error surfacing. */
  async resolveOrigin(pluginName: string): Promise<string | undefined> {
    let plugins;
    try {
      plugins = await this.deps.repository.getPlugins();
    } catch (e) {
      this.log(`[EditingController] resolveOrigin(${pluginName}) failed: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    }
    return plugins.find((p) => p.name === pluginName && p.inLoadOrder)?.origin;
  }

  /** ADR-0041: the Track gesture. Origin names the mod folder — every loaded plugin sharing
   *  it is tracked together, resolved backend-side — Mod Management resolved the origin.
   *
   *  Returns whether it happened. A failure is ADR-0026's "explicit action failed" tier: the user
   *  ran a command, so it is notified rather than only logged, and nothing is refreshed since
   *  nothing changed (a 409 here means the mod folder was already tracked). */
  async track(
    origin: string, preset: 'Edits' | 'Everything', options: { onProgress?: (status: TrackStatus) => void } = {},
  ): Promise<boolean> {
    // The POST stays blocking, same contract as putLoadOrder's own — so
    // progress is polled off GET /plugins/track/status *alongside* the still in-flight POST
    // (no `signal`: Track has no cancellation). Started before the await, stopped before the
    // refresh: the poll's whole reason to exist is the window the POST covers.
    const stopPolling = this.pollStatus(
      'GET /plugins/track/status', () => this.deps.repository.getTrackStatus(), options.onProgress,
    );
    let tracked: boolean;
    try {
      tracked = await this.mutate({
        op: `track(${origin})`,
        failMsg: `mEdit: Could not track "${origin}"`,
        post: () => this.deps.client.POST('/plugins/track', { body: { origin, preset } }),
        map: () => true,
        failure: false,
      });
    } finally {
      stopPolling();
    }
    // Tracked-ness (.git presence) isn't plugin metadata the tree renders itself, but the caller
    // still needs a chance to re-register the new repo with vscode.git's SCM panel. Not
    // `refresh: 'both'`: tracking changes no record, so the filter-match set is untouched.
    if (tracked) this.deps.refreshTree();
    return tracked;
  }

  /** Create-record — mints a new record as a working-tree source file (ADR-0041), answering
   *  at Effective only until committed and compiled. `formKey` is xEdit's typed-FormID path; left
   *  undefined, the backend auto-allocates the next free local FormID (both-refs collision-safe).
   *
   *  Returns the new FormKey on success, `undefined` on failure (already surfaced) — the caller
   *  (the tree-row command) has nothing further to do with it beyond the refresh below, but a test
   *  or a future "reveal the new record" gesture can use it.
   *
   *  `onEslContradiction` is #290's prompt-and-retry hook: creation can outgrow the ESL range the
   *  same way compile's own content can (reachable in practice only via a large batch copy landing
   *  in one gesture, per #290's ruling — an ordinary single-record create starts from an empty
   *  plugin) — when it does, the caller decides whether to remove the flag, and accepting retries
   *  this same call once, exactly as `compileAndReport`'s own retry does. Left unset, an
   *  ESL-contradiction refusal surfaces as the ordinary toast like any other refusal. */
  async createRecord(
    plugin: string, origin: string, recordType: string, editorId?: string, formKey?: string,
    onEslContradiction?: (message: string) => Promise<boolean>,
  ): Promise<string | undefined> {
    return this.mutate({
      op: `createRecord(${plugin}, ${recordType})`,
      failMsg: `mEdit: Could not create a new ${recordType} record in "${plugin}"`,
      post: () => this.deps.client.POST('/plugins/{plugin}/records', {
        params: { path: { plugin } },
        body: { origin, recordType, editorId: editorId ?? null, formKey: formKey ?? null },
      }),
      refresh: 'both',
      map: (data) => data?.formKey ?? undefined,
      failure: undefined,
      onEslContradiction: onEslContradiction && (async (message) => (
        (await onEslContradiction(message))
          ? this.createRecord(plugin, origin, recordType, editorId, formKey, onEslContradiction)
          : undefined
      )),
    });
  }

  /** Delete-record — the source file goes away and the null-Body mechanism takes it from
   *  there (gone at Effective, still served at Head until compiled). The confirmation ("are you
   *  sure") is extension-side UX, the same division `compile`'s compile-at-main modal already
   *  established — this method never asks, only acts. Returns whether it happened. */
  async deleteRecord(formKey: string, plugin: string, origin: string): Promise<boolean> {
    return this.mutate({
      op: `deleteRecord(${formKey})`,
      failMsg: `mEdit: Could not delete ${formKey}`,
      post: () => this.deps.client.POST('/records/{formKey}/delete', {
        params: { path: { formKey } },
        body: { plugin, origin },
      }),
      refresh: 'both',
      map: () => true,
      failure: false,
    });
  }

  /** Renumber — a delete+create pair plus the cross-plugin reference cascade (native records
   *  only; an override is refused server-side, naming the originating plugin). `newFormKey` is
   *  xEdit's typed-FormID path; left undefined, the backend auto-allocates. Returns the new FormKey
   *  on success, `undefined` on failure (already surfaced, including the untracked-referencer and
   *  partial-cascade-failure cases — both typed/messaged server-side). */
  async renumberRecord(formKey: string, plugin: string, origin: string, newFormKey?: string): Promise<string | undefined> {
    return this.mutate({
      op: `renumberRecord(${formKey})`,
      failMsg: `mEdit: Could not renumber ${formKey}`,
      post: () => this.deps.client.POST('/records/{formKey}/renumber', {
        params: { path: { formKey } },
        body: { plugin, origin, newFormKey: newFormKey ?? null },
      }),
      refresh: 'both',
      map: (data) => data?.newFormKey ?? undefined,
      failure: undefined,
    });
  }

  /** Copy as Override Into… — the source record's own bytes land under the identical
   *  FormKey in the destination plugin's working tree. No confirmation ("are you sure") — xEdit's
   *  own CopyInto asks nothing before an override copy either, only before an EditorID-changing
   *  copy-as-new. Returns whether it happened; success carries no new FormKey to report (the
   *  backend's own `RecordEditResult.Success()` — an override echoes the caller's FormKey rather
   *  than minting one), the same "success, nothing new" shape `deleteRecord` already uses. */
  async copyRecordAsOverride(
    formKey: string, sourcePlugin: string, sourceOrigin: string, destinationPlugin: string, destinationOrigin: string,
  ): Promise<boolean> {
    return this.mutate({
      op: `copyRecordAsOverride(${formKey})`,
      failMsg: `mEdit: Could not copy ${formKey} into "${destinationPlugin}"`,
      post: () => this.deps.client.POST('/records/{formKey}/copy-as-override', {
        params: { path: { formKey } },
        body: { sourcePlugin, sourceOrigin, destinationPlugin, destinationOrigin },
      }),
      refresh: 'both',
      map: () => true,
      failure: false,
    });
  }

  /** Copy as New Record Into… — a deep copy under a fresh FormKey (auto-allocated,
   *  both-refs collision-safe, or `requestedFormKey`'s explicit typed-FormID path). No EditorID
   *  prompt, unlike xEdit's own copy-as-new: the backend's request carries no EditorID field at
   *  all, and `createRecord`'s own "land immediately, rename via the grid afterward" posture
   *  already applies the same zero-friction answer to a freshly-created record — extending it here
   *  is consistency with that existing decision, not a fresh divergence. Returns the new FormKey on
   *  success, `undefined` on failure (already surfaced).
   *
   *  `onEslContradiction` is `createRecord`'s own #290 prompt-and-retry hook — this is the gesture
   *  the ruling actually flags as the realistic way to hit it (a destination plugin's ESL space
   *  outgrown by copies landing into it), so it gets the identical treatment. */
  async copyRecordAsNewRecord(
    formKey: string, sourcePlugin: string, sourceOrigin: string, destinationPlugin: string, destinationOrigin: string,
    requestedFormKey?: string, onEslContradiction?: (message: string) => Promise<boolean>,
  ): Promise<string | undefined> {
    return this.mutate({
      op: `copyRecordAsNewRecord(${formKey})`,
      failMsg: `mEdit: Could not copy ${formKey} into "${destinationPlugin}"`,
      post: () => this.deps.client.POST('/records/{formKey}/copy-as-new-record', {
        params: { path: { formKey } },
        body: {
          sourcePlugin, sourceOrigin, destinationPlugin, destinationOrigin, requestedFormKey: requestedFormKey ?? null,
        },
      }),
      refresh: 'both',
      map: (data) => data?.newFormKey ?? undefined,
      failure: undefined,
      onEslContradiction: onEslContradiction && (async (message) => (
        (await onEslContradiction(message))
          ? this.copyRecordAsNewRecord(
            formKey, sourcePlugin, sourceOrigin, destinationPlugin, destinationOrigin, requestedFormKey,
            onEslContradiction,
          )
          : undefined
      )),
    });
  }

  /** Save & Compile. `atRef` is the compile-at-`main` gesture's own target (never a
   *  "confirmed" flag — the confirmation itself is extension-side UX, S13); undefined is the
   *  normal working-tree compile. Returns null (not a thrown error) on a transport/HTTP failure —
   *  distinct from `CompileResult.succeeded === false`, which is a *typed refusal* the caller
   *  should show as-is, not a surprise. Never refreshes the tree itself: a compiled binary changes
   *  nothing `GET /plugins` reports (masters, load order), only bytes on disk — which the index's
   *  own mirror watch re-reads. */
  async compile(plugin: string, origin: string, atRef?: string): Promise<CompileResult | null> {
    return this.mutate({
      op: `compile(${plugin})`,
      failMsg: `mEdit: Could not compile "${plugin}"`,
      post: () => this.deps.client.POST('/plugins/{plugin}/compile', {
        params: { path: { plugin } },
        body: { origin, ref: atRef ?? null },
      }),
      map: (data) => data ?? null,
      failure: null,
    });
  }

  /** Absorb Upstream Update. Returns null on a transport/HTTP failure, distinct from
   *  `ExternalChangeActionResult.succeeded === false` (a typed refusal, shown as-is — Absorb only
   *  refuses on an IO fault, per the pinned contract). Refreshes the tree: a new baseline can move
   *  provenance the tree reads (trailers), the same reason `track` does. */
  async absorbUpstreamUpdate(plugin: string, origin: string): Promise<ExternalChangeActionResult | null> {
    return this.mutate({
      op: `absorbUpstreamUpdate(${plugin})`,
      failMsg: `mEdit: Could not absorb the upstream update for "${plugin}"`,
      post: () => this.deps.client.POST('/plugins/{plugin}/external-change/absorb', {
        params: { path: { plugin } },
        body: { origin },
      }),
      // Only a succeeded absorb moved the baseline; a typed refusal changed nothing to re-read.
      refresh: (data) => data?.succeeded === true,
      map: (data) => data ?? null,
      failure: null,
    });
  }

  /** Keep as My Edit. A same-record collision with existing working-tree dirt is a typed
   *  refusal (`succeeded === false`, `refusalReason` naming the records), never an HTTP error. */
  async keepAsMyEdit(plugin: string, origin: string): Promise<ExternalChangeActionResult | null> {
    return this.mutate({
      op: `keepAsMyEdit(${plugin})`,
      failMsg: `mEdit: Could not keep "${plugin}" as your own edit`,
      post: () => this.deps.client.POST('/plugins/{plugin}/external-change/keep', {
        params: { path: { plugin } },
        body: { origin },
      }),
      // Keeping an external change deserializes into working-tree dirt — same reason as
      // absorbUpstreamUpdate above, same refusal-changes-nothing condition.
      refresh: (data) => data?.succeeded === true,
      map: (data) => data ?? null,
      failure: null,
    });
  }

  /** The offered rebase — origin-scoped (the repo, not any one plugin, is the unit of
   *  baselines and rebase). Refresh happens either way: `Clean` moved the branch, `Refused` is
   *  worth nothing to refresh, `Conflicted` leaves the repo mid-rebase, which the panel should
   *  reflect regardless. */
  async rebaseOntoMain(origin: string): Promise<RebaseResult | null> {
    return this.postRebase('/plugins/rebase', origin, 'rebaseOntoMain');
  }

  /** Resumes a rebase left mid-flight by {@link rebaseOntoMain}'s own `Conflicted` outcome,
   *  after the user has hand-resolved the conflicted source file(s) in the native merge editor. */
  async continueRebase(origin: string): Promise<RebaseResult | null> {
    return this.postRebase('/plugins/rebase/continue', origin, 'continueRebase');
  }

  private async postRebase(
    path: '/plugins/rebase' | '/plugins/rebase/continue', origin: string, opName: string,
  ): Promise<RebaseResult | null> {
    return this.mutate({
      op: `${opName}(${origin})`,
      failMsg: `mEdit: Could not rebase "${origin}"`,
      post: () => this.deps.client.POST(path, { body: { origin } }),
      // Unconditional (unlike absorb/keep): `Conflicted` leaves the repo mid-rebase and `Refused`
      // is still worth reflecting — the doc comment on rebaseOntoMain carries the full reasoning.
      refresh: 'both',
      map: (data) => data ?? null,
      failure: null,
    });
  }
}



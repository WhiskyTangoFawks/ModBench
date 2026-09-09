import type { components } from './generated/api';
import type {
  ApiClient, CompileResult, LoadOrderStatus, TrackStatus, ExternalChangeActionResult, RebaseResult,
  CrashRepairOffer, NotificationEvent,
} from './ApiClient';
import { errorText, isWriteGateTimeout, writeGateBusyMessage, toLoadOrderStatus } from './ApiClient';
import type { PluginRepository } from './PluginRepository';
import type { NotificationSubscriber, NotificationKind } from './NotificationSubscriber';
import { reportSkippedPlugins } from './pluginFailures';

export interface EditingControllerDeps {
  client: ApiClient;
  repository: PluginRepository;
  /** ADR-0046 invariant 12: `putLoadOrder`'s and `track`'s own progress ride this rather than a
   *  poll — see `subscribeStatus`. */
  notificationSubscriber: NotificationSubscriber;
  refreshTree: () => void;
  setStatusText: (text: string) => void;
  showWarning: (msg: string) => void;
  showError: (msg: string) => void;
  /** `label` names the filter's *source* (a `.sql` filename, or the document it was applied from)
   *  — undefined when it isn't known, as for a filter read back off the backend. */
  setFilterActive: (active: boolean, sql?: string, label?: string) => void;
  /** Called whenever the record filter's per-plugin match set can have changed. Symmetric on
   *  purpose: a stale `false` surviving a clear would leave a plugin permanently unexpandable
   *  (ADR-0035). */
  refreshMatchingPlugins: () => void;
  // Called exactly when a `putLoadOrder` resolves `{ outcome: 'reconciled' }` — every reconcile
  // that changes anything re-sweeps, so this fires on every one, not only the first (ADR-0044).
  notifyConflictsComputed: () => void;
  log?: (msg: string) => void;
}

// A transport error's `error` never carries this extension, so a truthy check is enough.
function eslContradictionMessage(error: unknown): string | undefined {
  const problem = error as { eslContradiction?: boolean; detail?: string } | undefined;
  return problem?.eslContradiction ? (problem.detail ?? errorText(error)) : undefined;
}

/** Re-exported under its own name because it is a callback contract, not merely a repository
 *  return type the caller happens to see. */
export type LoadOrderProgress = LoadOrderStatus;

/** Restated rather than imported: this module belongs to Editing, which imports nothing from the
 *  other context. `slot` is null when no plugins.txt line names this copy. */
export interface LoadOrderPluginInput {
  name: string;
  path: string;
  origin: string;
  slot: number | null;
  enabled: boolean;
  winning: boolean;
}

/** A tagged union rather than a sentinel value, which would be a rule every call site must
 *  remember. `abandoned` means the reconcile was superseded or the user closed mEdit — nothing
 *  went wrong, and nothing is torn down. */
export type LoadOrderOutcome =
  | { outcome: 'reconciled'; failures: components['schemas']['PluginLoadFailure'][]; crashRepairOffers: CrashRepairOffer[] }
  | { outcome: 'failed' }
  | { outcome: 'abandoned' };

/** Deliberately plain stdlib — `AbortSignal`, not a bespoke token — so this interface carries no
 *  VS Code types and `openapi-fetch` can forward it straight to `fetch`. */
export interface LoadOrderOptions {
  /** Called on each `load-order-status` notification while the PUT is in flight. Never called
   *  after the reconcile settles. */
  onProgress?: (progress: LoadOrderProgress) => void;
  /** Trips when the user deliberately abandons this reconcile (closing mEdit). Aborts the PUT
   *  itself rather than waiting for a dead socket. */
  signal?: AbortSignal;
}

/** Editing's HTTP orchestration — every gesture the extension makes against the backend, with
 *  no VS Code types in its interface (VS Code chat tool handlers call it directly — ADR-0012). */
export class EditingController {
  private readonly log: (msg: string) => void;
  constructor(private readonly deps: EditingControllerDeps) {
    this.log = deps.log ?? (() => {});
  }

  /** Deliberately does not refresh the tree: that only makes sense once the caller's own
   *  `plugins.txt` append has also landed, so a partially-done create is never shown as done. */
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

  /** ADR-0046: Refresh's first step — drops the instance's index file and reopens it empty,
   *  refusing (423) exactly as `putLoadOrder` does when another window holds it. `onFailure` is
   *  the caller's report, never a bare toast (modbench/CLAUDE.md). */
  async rebuildIndex(
    instanceRoot: string,
    onFailure: (message: string, detail: string) => void,
    gameRelease = 'Fallout4',
  ): Promise<boolean> {
    const { error, response } = await this.deps.client.POST('/index/rebuild', {
      body: { instanceRoot, gameRelease },
    });
    if (!response.ok) {
      const text = errorText(error);
      this.log(`[EditingController] rebuildIndex failed (${response.status}): ${text}`);
      onFailure('mEdit: Could not rebuild the index', text);
      return false;
    }
    return true;
  }

  /** `gameDirectory` must be the resolved Data folder — the backend prepends implicit masters
   *  from it. The backend keys its persistent index on `instanceRoot` (ADR-0001) because `origin`
   *  is a folder *name*, unique only within one instance. */
  async putLoadOrder(
    plugins: LoadOrderPluginInput[],
    gameDirectory: string,
    instanceRoot: string,
    gameRelease = 'Fallout4',
    options: LoadOrderOptions = {},
  ): Promise<LoadOrderOutcome> {
    // The PUT stays blocking and the generated openapi-fetch client has no streaming path, so
    // progress rides the load-order-status notification alongside the still in-flight PUT.
    const unsubscribe = this.subscribeStatus(
      'load-order-status', (event) => (event.loadOrderStatus ? toLoadOrderStatus(event.loadOrderStatus) : undefined),
      options.onProgress,
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
      unsubscribe();
    }
    const { data, error, response } = result;
    // 409 is the backend saying this snapshot was superseded: treating it as a failure would make
    // the caller act on a load order the newer snapshot now owns. Checked before `!response.ok`,
    // which would otherwise swallow it.
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
    // `data` is undefined only on a non-ok response, already returned above; both lists are
    // non-nullable on the wire, so there is nothing left to coalesce per field.
    const reconciled = data ?? { failures: [], crashRepairOffers: [] };
    return this.reportReconciled(plugins, reconciled.failures, reconciled.crashRepairOffers);
  }

  // An abort is the one rejection that is not a failure: the teardown is already underway.
  private wasDeliberatelyAborted(signal: AbortSignal | undefined): boolean {
    if (!signal?.aborted) return false;
    this.log('[EditingController] putLoadOrder was aborted — mEdit was closed while it reconciled');
    return true;
  }

  private reportReconciled(
    plugins: LoadOrderPluginInput[],
    failures: components['schemas']['PluginLoadFailure'][],
    crashRepairOffers: CrashRepairOffer[],
  ): LoadOrderOutcome {
    reportSkippedPlugins(failures, {
      log: (m) => this.log(`[EditingController] ${m}`),
      warn: this.deps.showWarning,
    });
    // Participation is derived — enabled AND winning AND listed — and the snapshot is every copy,
    // so a non-empty one can still have nothing that participates, leaving only base-game masters
    // loaded while the user believes otherwise (ADR-0044).
    if (!plugins.some((p) => p.enabled && p.winning && p.slot !== null)) {
      this.deps.showWarning(
        'mEdit: The active profile has no enabled plugins — only base-game masters are held. ' +
          'Enable plugins in the mod list (or check the profile\'s plugins.txt).',
      );
    }
    this.deps.setStatusText(`$(check) mEdit: Ready (${plugins.length} plugin copies)`);
    this.deps.refreshTree();
    // The backend answers this PUT only after the winner sweep, so reaching here *is* "conflicts
    // are computed" — reusing that fact rather than adding a second poller or a second notion of
    // a settled load order (ADR-0035).
    this.deps.notifyConflictsComputed();
    return { outcome: 'reconciled', failures, crashRepairOffers };
  }

  // ADR-0046 invariant 12: `putLoadOrder` and `track` each ride one notification kind. `extract`
  // picks that kind's payload out of the flat wire envelope; undefined skips the event.
  private subscribeStatus<T>(
    kind: NotificationKind,
    extract: (event: NotificationEvent) => T | undefined,
    onProgress: ((status: T) => void) | undefined,
  ): () => void {
    if (!onProgress) return () => {};
    return this.deps.notificationSubscriber.subscribe(kind, (event) => {
      const status = extract(event);
      if (status !== undefined) onProgress(status);
    });
  }

  // `refresh: 'both'` also re-reads the per-plugin filter matches: a changed record can start or
  // stop matching the active filter (ADR-0035).
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
        // Contended, not broken — the write was never attempted, so this is worth repeating.
        // Before the generic branch, which would relay the backend's own timeout prose verbatim
        // and read as fatally as a load order that has gone away.
        if (isWriteGateTimeout(error)) {
          this.log(`[EditingController] ${spec.op} hit the write gate (${response.status}): ${errorText(error)}`);
          this.deps.showError(writeGateBusyMessage(spec.failMsg));
          return spec.failure;
        }
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

  /** The origin the load order names for this plugin. A transport failure degrades to
   *  `undefined` (ADR-0026); without the catch, a call before the backend runs surfaces VS Code's
   *  raw "fetch failed" toast. */
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

  /** The plugins this install loads with no plugins.txt line — implicit masters and the Creation
   *  Club catalog — in load order. `undefined` on any failure: "unknown" and "none" are different
   *  answers, and Mod Management's reconcile treats them differently. */
  async implicitMasters(gameDirectory: string, gameRelease = 'Fallout4'): Promise<string[] | undefined> {
    let result;
    try {
      result = await this.deps.client.GET('/implicit-masters', { params: { query: { gameDirectory, gameRelease } } });
    } catch (e) {
      this.log(`[EditingController] implicitMasters failed: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    }
    if (!result.response.ok || result.data === undefined) {
      this.log(`[EditingController] implicitMasters failed (${result.response.status}): ${errorText(result.error)}`);
      return undefined;
    }
    return result.data;
  }

  /** The Track gesture (ADR-0041): every loaded plugin sharing `origin` is tracked together,
   *  resolved backend-side. Nothing is refreshed on failure — a 409 means it was already
   *  tracked. */
  async track(
    origin: string, preset: 'Edits' | 'Everything', options: { onProgress?: (status: TrackStatus) => void } = {},
  ): Promise<boolean> {
    // The POST stays blocking, so progress rides the track-progress notification alongside it.
    const unsubscribe = this.subscribeStatus('track-progress', (event) => event.trackProgress ?? undefined, options.onProgress);
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
      unsubscribe();
    }
    // Tracked-ness isn't plugin metadata the tree renders, but the caller needs to re-register the
    // new repo with vscode.git's SCM panel. Not `refresh: 'both'`: tracking changes no record, so
    // the filter-match set is untouched.
    if (tracked) {
      this.deps.refreshTree();
      this.deps.notifyConflictsComputed();
    }
    return tracked;
  }

  /** `formKey` is xEdit's typed-FormID path; left undefined, the backend auto-allocates.
   *  `onEslContradiction` opts in to prompt-and-retry: a light plugin's allocator ceiling is
   *  local `0xFFF`, so a destination already at it refuses the next mint. */
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

  /** The source file goes away and the null-Body mechanism takes it from there: gone at
   *  Effective, still served at Head until compiled. This method never asks for confirmation. */
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

  /** A delete+create pair plus the cross-plugin reference cascade; an override is refused
   *  server-side (native records only). `newFormKey` is xEdit's typed-FormID path; left undefined,
   *  the backend auto-allocates. */
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

  /** No confirmation — xEdit's own CopyInto asks nothing before an override copy either, only
   *  before an EditorID-changing copy-as-new. Success carries no new FormKey: an override echoes
   *  the caller's own. */
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

  /** A deep copy under a fresh FormKey. No EditorID prompt, unlike xEdit's own copy-as-new: the
   *  request carries no EditorID field, matching `createRecord`'s land-now, rename-in-the-grid
   *  posture. */
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

  /** Returns null on a transport/HTTP failure — distinct from `succeeded === false`, a typed
   *  refusal shown as-is. Never refreshes the tree: a compiled binary changes only bytes on disk,
   *  which the index's own mirror watch re-reads. */
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

  /** Returns null on a transport/HTTP failure, distinct from a typed refusal. Refreshes the tree:
   *  a new baseline can move the provenance trailers the tree reads. */
  async absorbUpstreamUpdate(plugin: string, origin: string): Promise<ExternalChangeActionResult | null> {
    const failMsg = `mEdit: Could not absorb the upstream update for "${plugin}"`;
    const result = await this.mutate({
      op: `absorbUpstreamUpdate(${plugin})`,
      failMsg,
      post: () => this.deps.client.POST('/plugins/{plugin}/external-change/absorb', {
        params: { path: { plugin } },
        body: { origin },
      }),
      // Only a succeeded absorb moved the baseline; a typed refusal changed nothing to re-read.
      refresh: (data) => data?.succeeded === true,
      map: (data) => data ?? null,
      failure: null,
    });
    // A refusal rides a 200, which mutate's error path never sees. Unsurfaced it leaves the
    // plugin unabsorbed and still read-only with nothing saying why (ADR-0026).
    if (result && !result.succeeded) {
      this.log(`[EditingController] absorbUpstreamUpdate(${plugin}) refused: ${result.refusalReason ?? ''}`);
      this.deps.showError(`${failMsg} — ${result.refusalReason ?? ''}`);
    }
    return result;
  }

  /** A same-record collision with existing working-tree dirt is a typed refusal
   *  (`succeeded === false`, `refusalReason` naming the records), never an HTTP error. */
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

  /** Origin-scoped: the repo, not any one plugin, is the unit of baselines and rebase. Refresh
   *  happens either way — `Conflicted` leaves the repo mid-rebase, which the panel must
   *  reflect. */
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
      // is still worth reflecting.
      refresh: 'both',
      map: (data) => data ?? null,
      failure: null,
    });
  }
}



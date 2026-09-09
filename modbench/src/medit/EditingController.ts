import type { components } from './generated/api';
import type {
  ApiClient, CompileResult, LoadOrderStatus, TrackStatus, ExternalChangeActionResult, RebaseResult,
  CrashRepairOffer, NotificationEvent,
} from './ApiClient';
import { errorText, isWriteGateTimeout, writeGateBusyMessage, toLoadOrderStatus } from './ApiClient';
import type { PluginRepository } from './PluginRepository';
import type { NotificationSubscriber, NotificationKind } from './NotificationSubscriber';

export interface EditingControllerDeps {
  client: ApiClient;
  repository: PluginRepository;
  /** ADR-0046 invariant 12: `putLoadOrder`'s and `track`'s own progress ride this rather than a
   *  poll — see `subscribeStatus`. */
  notificationSubscriber: NotificationSubscriber;
  log?: (msg: string) => void;
}

/** A write verb's outright refusal — non-2xx, a thrown request, or write-gate contention.
 *  `message` is the ready-to-show toast (ADR-0026); a 200 typed refusal lives on the success
 *  arm instead. */
export interface WriteRefused {
  readonly refused: true;
  readonly message: string;
}

/** `WriteRefused`'s one structural tag — a plain check, not `instanceof`, so a scripted client's
 *  plain object literal narrows the same way the real one does. */
export function isRefused(result: unknown): result is WriteRefused {
  return typeof result === 'object' && result !== null && (result as { refused?: unknown }).refused === true;
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

/** A tagged union, not a sentinel value. `abandoned` means the reconcile was superseded or the
 *  user closed mEdit; `failed`'s `message` is the whole toast the load-order sync shows. */
export type LoadOrderOutcome =
  | { outcome: 'reconciled'; failures: components['schemas']['PluginLoadFailure'][]; crashRepairOffers: CrashRepairOffer[] }
  | { outcome: 'failed'; message: string }
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

/** Editing's HTTP orchestration — every gesture against the backend, with no VS Code types in
 *  its interface (ADR-0012). It calls the backend, maps failures onto {@link WriteRefused}, and
 *  returns what happened; callers decide whether to toast, refresh, or refetch. */
export class EditingController {
  private readonly log: (msg: string) => void;
  constructor(private readonly deps: EditingControllerDeps) {
    this.log = deps.log ?? (() => {});
  }

  async createPlugin(
    name: string, path: string, origin: string,
  ): Promise<components['schemas']['PluginCreatedResponse'] | WriteRefused> {
    const { error, response, data } = await this.deps.client.POST('/plugins/create', { body: { name, path, origin } });
    if (!response.ok) {
      const text = errorText(error);
      this.log(`[EditingController] createPlugin failed (${response.status}): ${text}`);
      return { refused: true, message: `mEdit: Failed to create plugin — ${text}` };
    }
    return data ?? { name, path, origin, slot: null };
  }

  /** ADR-0046: Refresh's first step — drops the instance's index file and reopens it empty,
   *  refusing (423) exactly as `putLoadOrder` does when another window holds it. `onFailure` is
   *  the caller's report, never a bare toast (modbench/CLAUDE.md). */
  async rebuildIndex(
    instanceRoot: string,
    onFailure: (message: string, detail: string) => void,
    gameRelease: string,
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
    gameRelease: string,
    options: LoadOrderOptions = {},
  ): Promise<LoadOrderOutcome> {
    // The PUT stays blocking and the generated openapi-fetch client has no streaming path, so
    // progress rides the load-order-status notification alongside the still in-flight PUT.
    const unsubscribe = this.subscribeStatus(
      'load-order-status', (event) => (event.loadOrderStatus ? toLoadOrderStatus(event.loadOrderStatus) : undefined),
      options.onProgress,
    );
    // The backend publishes its first tick as this PUT lands, so a PUT that outran the stream
    // loses every tick published before it connects — and with them the progressive chevrons.
    await this.deps.notificationSubscriber.whenConnected();
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
      return { outcome: 'failed', message: `mEdit: Failed to send the load order — ${text}` };
    }
    // `data` is undefined only on a non-ok response, already returned above; both lists are
    // non-nullable on the wire, so there is nothing left to coalesce per field.
    const reconciled = data ?? { failures: [], crashRepairOffers: [] };
    return { outcome: 'reconciled', failures: reconciled.failures, crashRepairOffers: reconciled.crashRepairOffers };
  }

  // An abort is the one rejection that is not a failure: the teardown is already underway.
  private wasDeliberatelyAborted(signal: AbortSignal | undefined): boolean {
    if (!signal?.aborted) return false;
    this.log('[EditingController] putLoadOrder was aborted — mEdit was closed while it reconciled');
    return true;
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

  // Every write verb below shares this shape: POST, map a non-ok response or a thrown request
  // onto WriteRefused, otherwise hand back the wire data untouched. No refresh, no toast — the
  // caller does both, from what this returns.
  private async mutate<T>(spec: {
    op: string;
    failMsg: string;
    post: () => Promise<{ data?: T; error?: unknown; response: { ok: boolean; status: number } }>;
    onEslContradiction?: (message: string) => Promise<T | WriteRefused | undefined>;
  }): Promise<T | WriteRefused | undefined> {
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
          return { refused: true, message: writeGateBusyMessage(spec.failMsg) };
        }
        const text = errorText(error);
        this.log(`[EditingController] ${spec.op} failed (${response.status}): ${text}`);
        return { refused: true, message: `${spec.failMsg} — ${text}` };
      }
      return data;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.log(`[EditingController] ${spec.op} threw: ${message}`);
      return { refused: true, message: `${spec.failMsg} — ${message}` };
    }
  }

  /** `error` is the repository's own mapped message, or `null` on success — returned exactly as
   *  received. The filter's source label is the caller's own readout, never this method's. */
  async setFilter(sql: string): Promise<string | null> {
    return this.deps.repository.setFilter(sql);
  }

  async clearFilter(): Promise<void> {
    await this.deps.repository.clearFilter();
  }

  /** A `WriteRefused` — distinct from `null` ("no active filter") — means the read itself
   *  failed; its `message` is the whole toast the caller shows. */
  async syncFilterState(): Promise<string | null | WriteRefused> {
    try {
      return await this.deps.repository.getActiveFilter();
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      this.log(`[EditingController] syncFilterState failed: ${detail}`);
      return {
        refused: true,
        message: `mEdit: Could not read the active filter — treating the filter as inactive. ${detail}`,
      };
    }
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

  /** The plugins this install loads with no plugins.txt line, in load order. `undefined` on any
   *  failure: "unknown" and "none" are different answers, and the reconcile writes on one. */
  async implicitMasters(gameDirectory: string, gameRelease: string): Promise<string[] | undefined> {
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
   *  resolved backend-side. A 409 means it was already tracked. */
  async track(
    origin: string, preset: 'Edits' | 'Everything', options: { onProgress?: (status: TrackStatus) => void } = {},
  ): Promise<components['schemas']['TrackResponse'] | WriteRefused> {
    // The POST stays blocking, so progress rides the track-progress notification alongside it.
    const unsubscribe = this.subscribeStatus('track-progress', (event) => event.trackProgress ?? undefined, options.onProgress);
    try {
      return await this.mutate<components['schemas']['TrackResponse']>({
        op: `track(${origin})`,
        failMsg: `mEdit: Could not track "${origin}"`,
        post: () => this.deps.client.POST('/plugins/track', { body: { origin, preset } }),
      }) as components['schemas']['TrackResponse'] | WriteRefused;
    } finally {
      unsubscribe();
    }
  }

  /** `formKey` is xEdit's typed-FormID path; left undefined, the backend auto-allocates.
   *  `onEslContradiction` opts in to prompt-and-retry; resolves `undefined` when the caller
   *  declines the prompt — nothing happened, not a refusal. */
  async createRecord(
    plugin: string, origin: string, recordType: string, editorId?: string, formKey?: string,
    onEslContradiction?: (message: string) => Promise<boolean>,
  ): Promise<components['schemas']['RecordCreateResponse'] | WriteRefused | undefined> {
    return this.mutate<components['schemas']['RecordCreateResponse']>({
      op: `createRecord(${plugin}, ${recordType})`,
      failMsg: `mEdit: Could not create a new ${recordType} record in "${plugin}"`,
      post: () => this.deps.client.POST('/plugins/{plugin}/records', {
        params: { path: { plugin } },
        body: { origin, recordType, editorId: editorId ?? null, formKey: formKey ?? null },
      }),
      onEslContradiction: onEslContradiction && (async (message) => (
        (await onEslContradiction(message))
          ? this.createRecord(plugin, origin, recordType, editorId, formKey, onEslContradiction)
          : undefined
      )),
    });
  }

  /** The source file goes away and the null-Body mechanism takes it from there: gone at
   *  Effective, still served at Head until compiled. This method never asks for confirmation. */
  async deleteRecord(
    formKey: string, plugin: string, origin: string,
  ): Promise<components['schemas']['RecordDeleteResponse'] | WriteRefused | undefined> {
    return this.mutate<components['schemas']['RecordDeleteResponse']>({
      op: `deleteRecord(${formKey})`,
      failMsg: `mEdit: Could not delete ${formKey}`,
      post: () => this.deps.client.POST('/records/{formKey}/delete', {
        params: { path: { formKey } },
        body: { plugin, origin },
      }),
    });
  }

  /** A delete+create pair plus the cross-plugin reference cascade; an override is refused
   *  server-side (native records only). `newFormKey` left undefined auto-allocates. */
  async renumberRecord(
    formKey: string, plugin: string, origin: string, newFormKey?: string,
  ): Promise<components['schemas']['RecordRenumberResponse'] | WriteRefused | undefined> {
    return this.mutate<components['schemas']['RecordRenumberResponse']>({
      op: `renumberRecord(${formKey})`,
      failMsg: `mEdit: Could not renumber ${formKey}`,
      post: () => this.deps.client.POST('/records/{formKey}/renumber', {
        params: { path: { formKey } },
        body: { plugin, origin, newFormKey: newFormKey ?? null },
      }),
    });
  }

  /** No confirmation — xEdit's own CopyInto asks nothing before an override copy. Success
   *  carries no new FormKey: an override echoes the caller's own. */
  async copyRecordAsOverride(
    formKey: string, sourcePlugin: string, sourceOrigin: string, destinationPlugin: string, destinationOrigin: string,
  ): Promise<components['schemas']['RecordCopyAsOverrideResponse'] | WriteRefused | undefined> {
    return this.mutate<components['schemas']['RecordCopyAsOverrideResponse']>({
      op: `copyRecordAsOverride(${formKey})`,
      failMsg: `mEdit: Could not copy ${formKey} into "${destinationPlugin}"`,
      post: () => this.deps.client.POST('/records/{formKey}/copy-as-override', {
        params: { path: { formKey } },
        body: { sourcePlugin, sourceOrigin, destinationPlugin, destinationOrigin },
      }),
    });
  }

  /** A deep copy under a fresh FormKey, no EditorID prompt. Resolves `undefined` when the caller
   *  declines the ESL prompt. */
  async copyRecordAsNewRecord(
    formKey: string, sourcePlugin: string, sourceOrigin: string, destinationPlugin: string, destinationOrigin: string,
    requestedFormKey?: string, onEslContradiction?: (message: string) => Promise<boolean>,
  ): Promise<components['schemas']['RecordCopyAsNewRecordResponse'] | WriteRefused | undefined> {
    return this.mutate<components['schemas']['RecordCopyAsNewRecordResponse']>({
      op: `copyRecordAsNewRecord(${formKey})`,
      failMsg: `mEdit: Could not copy ${formKey} into "${destinationPlugin}"`,
      post: () => this.deps.client.POST('/records/{formKey}/copy-as-new-record', {
        params: { path: { formKey } },
        body: {
          sourcePlugin, sourceOrigin, destinationPlugin, destinationOrigin, requestedFormKey: requestedFormKey ?? null,
        },
      }),
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

  /** {@link WriteRefused} on a transport/HTTP failure — distinct from `succeeded: false`, a typed
   *  refusal the caller reads off the returned `CompileResult` itself. Never refreshes the tree:
   *  a compiled binary changes only bytes on disk. */
  async compile(plugin: string, origin: string, atRef?: string): Promise<CompileResult | WriteRefused | undefined> {
    return this.mutate<CompileResult>({
      op: `compile(${plugin})`,
      failMsg: `mEdit: Could not compile "${plugin}"`,
      post: () => this.deps.client.POST('/plugins/{plugin}/compile', {
        params: { path: { plugin } },
        body: { origin, ref: atRef ?? null },
      }),
    });
  }

  /** A refusal (e.g. "could not be parsed") rides a 200 as `succeeded: false` — the caller reads
   *  `refusalReason` off the returned value itself. */
  async absorbUpstreamUpdate(plugin: string, origin: string): Promise<ExternalChangeActionResult | WriteRefused | undefined> {
    return this.mutate<ExternalChangeActionResult>({
      op: `absorbUpstreamUpdate(${plugin})`,
      failMsg: `mEdit: Could not absorb the upstream update for "${plugin}"`,
      post: () => this.deps.client.POST('/plugins/{plugin}/external-change/absorb', {
        params: { path: { plugin } },
        body: { origin },
      }),
    });
  }

  /** A same-record collision with existing working-tree dirt is a typed refusal
   *  (`succeeded === false`, `refusalReason` naming the records), never an HTTP error. */
  async keepAsMyEdit(plugin: string, origin: string): Promise<ExternalChangeActionResult | WriteRefused | undefined> {
    return this.mutate<ExternalChangeActionResult>({
      op: `keepAsMyEdit(${plugin})`,
      failMsg: `mEdit: Could not keep "${plugin}" as your own edit`,
      post: () => this.deps.client.POST('/plugins/{plugin}/external-change/keep', {
        params: { path: { plugin } },
        body: { origin },
      }),
    });
  }

  /** Origin-scoped: the repo, not any one plugin, is the unit of baselines and rebase. */
  async rebaseOntoMain(origin: string): Promise<RebaseResult | WriteRefused | undefined> {
    return this.postRebase('/plugins/rebase', origin, 'rebaseOntoMain');
  }

  /** Resumes a rebase left mid-flight by {@link rebaseOntoMain}'s own `Conflicted` outcome, after
   *  the user hand-resolves the conflicted source file(s) in the native merge editor. */
  async continueRebase(origin: string): Promise<RebaseResult | WriteRefused | undefined> {
    return this.postRebase('/plugins/rebase/continue', origin, 'continueRebase');
  }

  private async postRebase(
    path: '/plugins/rebase' | '/plugins/rebase/continue', origin: string, opName: string,
  ): Promise<RebaseResult | WriteRefused | undefined> {
    return this.mutate<RebaseResult>({
      op: `${opName}(${origin})`,
      failMsg: `mEdit: Could not rebase "${origin}"`,
      post: () => this.deps.client.POST(path, { body: { origin } }),
    });
  }
}

import type { RecordEditEnvelope } from '../wire/messages';
import {
  createApiClient, errorText, isTerminalLoadOrderStatusFor, openNotificationStream,
  toLoadOrderStatus, type ApiClient, type LoadOrderStatus, type CompareResult,
} from './apiClient';
import { createUnlimitedFetch } from './unlimitedFetch';
import { BackendLifecycle, type BackendLifecycleOptions } from './backendLifecycle';
import { SseNotificationSubscriber } from './notificationStream';
import {
  type BackendStatus, type CellChildRecords, type CompileOutcome,
  type ContainerChildSummary, type InteriorCellBlock, type LoadOrderOptions, type LoadOrderOutcome,
  type LoadOrderPluginInput, type LoadOrderProgress, type MEditClient, type NotificationEvent, type NotificationKind,
  type PluginCreatedResponse, type PluginDiagnosisReport, type PluginMetadata, type PluginRecordTypeCount, type CreatableRecordType,
  type RebuildIndexOutcome, type CopyItem, type CopyMode,
  type RecordAddress, type RecordCreateResponse, type RecordEditOutcome, type RecordPage,
  type RecordFilter, type ReferenceResult, type PluginAddress, type TrackStatus, type UpstreamVersionByOrigin,
  type WorldspaceBlocks, type WorldspaceSummary, type WriteRefused, isRefused,
} from './MEditClient';
import { errorMessage } from '../ports/errorMessage';
import type { SelectionOutcome } from '../ports/selectionOutcome';

// No convention in ADR-0019 or plugins.md anchors this: 30s is an ordinary
// HTTP-client default. A slow call and a hung one look the same to the tree, so nothing tries to
// tell them apart.
export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

export interface HttpMEditClientDeps {
  /** The process this client is the front of; nothing outside this module configures it. */
  backend: BackendLifecycleOptions;
  /** Overrides the production fetch (undici, unlimited timeouts) — a test scripts the backend's
   *  HTTP responses through this. */
  fetch?: (input: Request) => Promise<Response>;
  log?: (msg: string) => void;
  timeoutMs?: number;
}

/** ADR-0002/ADR-0014: the HTTP adapter, whole — the generated client, `openapi-fetch`, `undici`
 *  and the notification stream live only here, composed behind {@link MEditClient}. */
export class HttpMEditClient implements MEditClient {
  private api?: { port: number; client: ApiClient };
  private readonly fetchImpl: (input: Request) => Promise<Response>;
  private readonly log: (msg: string) => void;
  private readonly timeoutMs: number;
  private readonly lifecycle: BackendLifecycle;
  private readonly notifications: SseNotificationSubscriber;
  constructor(deps: HttpMEditClientDeps) {
    this.log = deps.log ?? (() => {});
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    this.fetchImpl = deps.fetch ?? createUnlimitedFetch();
    this.notifications = new SseNotificationSubscriber({
      openStream: (signal) => openNotificationStream(this.apiClient, signal),
      log: deps.log,
    });
    this.lifecycle = new BackendLifecycle(deps.backend);
    // ADR-0014 invariant 2: the stream is open exactly while the backend is attached, so no
    // module outside this one starts or stops it.
    this.lifecycle.onStatusChanged((status) => {
      if (status === 'running') this.notifications.start();
      else this.notifications.stop();
    });
  }

  // The port is the lifecycle's to choose, so the generated client is built once it is known.
  private get apiClient(): ApiClient {
    const port = this.lifecycle.port;
    if (port === undefined) throw new Error('mEdit has not started');
    if (this.api?.port !== port) this.api = { port, client: createApiClient(port, this.fetchImpl) };
    return this.api.client;
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  get status(): BackendStatus { return this.lifecycle.status; }
  onStatusChanged(listener: (status: BackendStatus) => void): () => void {
    return this.lifecycle.onStatusChanged(listener);
  }
  onReconnected(listener: () => void): () => void {
    return this.notifications.onReconnected(listener);
  }
  start(): Promise<void> { return this.lifecycle.start(); }
  stop(): Promise<void> { return this.lifecycle.stop(); }

  // ── notifications ────────────────────────────────────────────────────────

  subscribe(kind: NotificationKind, listener: (event: NotificationEvent) => void): () => void {
    return this.notifications.subscribe(kind, listener);
  }

  // ADR-0014 invariant 2: `track` rides its own notification kind. `extract` picks that kind's
  // payload out of the flat wire envelope; undefined skips the event.
  private subscribeStatus<T>(
    kind: NotificationKind,
    extract: (event: NotificationEvent) => T | undefined,
    onProgress: ((status: T) => void) | undefined,
  ): () => void {
    if (!onProgress) return () => {};
    return this.notifications.subscribe(kind, (event) => {
      const status = extract(event);
      if (status !== undefined) onProgress(status);
    });
  }

  // ── writes ───────────────────────────────────────────────────────────────

  // Every write verb below shares this shape: POST, map a non-ok response or a thrown request
  // onto WriteRefused, otherwise hand back the wire data untouched. No refresh, no toast — the
  // caller does both, from what this returns.
  private async mutate<T>(spec: {
    op: string;
    failMsg: string;
    post: () => Promise<{ data?: T; error?: unknown; response: { ok: boolean; status: number } }>;
  }): Promise<T | WriteRefused> {
    try {
      const { data, error, response } = await spec.post();
      if (!response.ok) {
        const text = errorText(error);
        this.log(`[HttpMEditClient] ${spec.op} failed (${response.status}): ${text}`);
        return { refused: true, message: `${spec.failMsg} — ${text}` };
      }
      return data ?? { refused: true, unanswered: true, message: `${spec.failMsg} — no answer` };
    } catch (e) {
      const message = errorMessage(e);
      this.log(`[HttpMEditClient] ${spec.op} threw: ${message}`);
      return { refused: true, unanswered: true, message: `${spec.failMsg} — ${message}` };
    }
  }

  async createPlugin(plugin: PluginAddress, folder: string): Promise<PluginCreatedResponse | WriteRefused> {
    const failMsg = `Could not create "${plugin.name}"`;
    const answer = await this.mutate({
      op: `createPlugin(${plugin.name}, ${plugin.origin})`,
      failMsg,
      post: () => this.apiClient.POST('/plugins/create', { body: { origin: plugin.origin, name: plugin.name, folder } }),
    });
    return answer;
  }

  /** ADR-0014: Refresh's first step; mEdit refills the index against the load order it holds.
   *  ADR-0009 invariant 5: a 423 is `heldElsewhere`, apart from every other failure — never a
   *  rejection. */
  async rebuildIndex(instanceRoot: string, gameRelease: string): Promise<RebuildIndexOutcome> {
    try {
      const { error, response } = await this.apiClient.POST('/index/rebuild', { body: { instanceRoot, gameRelease } });
      if (!response.ok) {
        const text = errorText(error);
        this.log(`[HttpMEditClient] rebuildIndex failed (${response.status}): ${text}`);
        if (response.status === 423) return { rebuilt: false, heldElsewhere: true };
        return { rebuilt: false, heldElsewhere: false, detail: text };
      }
      return { rebuilt: true };
    } catch (e) {
      const message = errorMessage(e);
      this.log(`[HttpMEditClient] rebuildIndex threw: ${message}`);
      return { rebuilt: false, heldElsewhere: false, detail: message };
    }
  }

  /** The backend keys its persistent index on `instanceRoot` (ADR-0009) because `origin` is a
   *  folder *name*, unique only within one instance. */
  async putLoadOrder(
    plugins: LoadOrderPluginInput[],
    active: PluginAddress[],
    loadedWithNoLine: PluginAddress[],
    gameDirectory: string,
    instanceRoot: string,
    gameRelease: string,
    options: LoadOrderOptions = {},
  ): Promise<LoadOrderOutcome> {
    // The backend publishes its first tick as this PUT lands, so a PUT that outran the stream
    // loses every tick published before it connects — and with them the progressive chevrons.
    await this.notifications.whenConnected();

    let resolveTerminal!: (status: LoadOrderProgress) => void;
    const terminal = new Promise<LoadOrderProgress>((resolve) => { resolveTerminal = resolve; });
    // A box, not a `let`: the subscriber below closes over it before this call's own PUT answers
    // with the version it holds.
    const applying: { version?: number; latest?: LoadOrderStatus } = {};
    const unsubscribe = this.notifications.subscribe('load-order-status', (event) => {
      if (!event.loadOrderStatus) return;
      const status = toLoadOrderStatus(event.loadOrderStatus);
      applying.latest = status;
      if (applying.version !== undefined && isTerminalLoadOrderStatusFor(status, applying.version)) resolveTerminal(status);
    });

    let result;
    try {
      result = await this.apiClient.PUT('/load-order', {
        body: { plugins, active, loadedWithNoLine, gameDirectory, instanceRoot, gameRelease },
        // Aborts the request itself rather than leaving it to notice a dead socket.
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (e) {
      unsubscribe();
      if (this.wasDeliberatelyAborted(options.signal)) return { outcome: 'abandoned' };
      throw e;
    }

    const { error, response, data } = result;
    if (!response.ok || !data) {
      unsubscribe();
      const text = errorText(error);
      this.log(`[HttpMEditClient] putLoadOrder failed (${response.status}): ${text}`);
      return { outcome: 'failed', message: `Failed to send the load order — ${text}` };
    }

    // Applied answers at once; the Index catches up on its own subscription, learned here by
    // version, never a tick a fast reconcile can publish before this call even subscribes.
    applying.version = data.version;
    const already = await this.terminalAlready(applying.latest, data.version);
    if (already) {
      unsubscribe();
      return { outcome: 'applied', status: already };
    }

    const unsubscribeReopen = this.rereadOnReopen(data.version, resolveTerminal);
    const status = await this.awaitTerminalOrAbort(terminal, options.signal);
    unsubscribe();
    unsubscribeReopen();
    return status === undefined ? { outcome: 'abandoned' } : { outcome: 'applied', status };
  }

  // A fast reconcile's tick can land before the PUT's answer, and an identical snapshot's no-op
  // publishes none: the latest tick the call heard, else the process's own current status.
  private async terminalAlready(
    latest: LoadOrderProgress | undefined, version: number,
  ): Promise<LoadOrderProgress | undefined> {
    if (latest && isTerminalLoadOrderStatusFor(latest, version)) return latest;
    const current = await this.currentLoadOrderStatus();
    return current && isTerminalLoadOrderStatusFor(current, version) ? current : undefined;
  }

  // A reopened stream carries none of the ticks published while it was down, so the process's
  // own status is read again when it opens.
  private rereadOnReopen(version: number, settle: (status: LoadOrderProgress) => void): () => void {
    return this.notifications.onReconnected(() => {
      void this.currentLoadOrderStatus().then((current) => {
        if (current && isTerminalLoadOrderStatusFor(current, version)) settle(current);
      });
    });
  }

  // Undefined when the read fails: the caller then waits on the stream's own ticks.
  private async currentLoadOrderStatus(): Promise<LoadOrderStatus | undefined> {
    try {
      const { data } = await this.apiClient.GET('/load-order/status', {});
      return data ? toLoadOrderStatus(data) : undefined;
    } catch (e) {
      this.log(`[HttpMEditClient] reading the load order status threw: ${errorMessage(e)}`);
      return undefined;
    }
  }

  // A close mid-reconcile abandons the wait, as an unsent snapshot is. The backend leaving
  // 'running' abandons it too — once the stream is gone, nothing is left to hear its tick.
  private awaitTerminalOrAbort(
    terminal: Promise<LoadOrderProgress>, signal: AbortSignal | undefined,
  ): Promise<LoadOrderProgress | undefined> {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (status: LoadOrderProgress | undefined): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        unlisten();
        resolve(status);
      };
      const onAbort = (): void => settle(undefined);
      signal?.addEventListener('abort', onAbort, { once: true });
      const unlisten = this.lifecycle.onStatusChanged((status) => {
        if (status !== 'running') settle(undefined);
      });
      void terminal.then(settle);
    });
  }

  // An abort is the one rejection that is not a failure: the teardown is already underway.
  private wasDeliberatelyAborted(signal: AbortSignal | undefined): boolean {
    if (!signal?.aborted) return false;
    this.log('[HttpMEditClient] putLoadOrder was aborted — mEdit was closed while it reconciled');
    return true;
  }

  /** The Track gesture (ADR-0007) over a selection: each plugin lands or is refused on its own. A
   *  cause no plugin escapes, git missing, refuses the whole selection. */
  async track(
    plugins: readonly PluginAddress[], preset: 'Edits' | 'Everything',
    upstreamVersionByOrigin: UpstreamVersionByOrigin,
    options: { onProgress?: (status: TrackStatus) => void } = {},
  ): Promise<SelectionOutcome<PluginAddress> | WriteRefused> {
    const counted = plugins.length === 1 ? '1 plugin' : `${plugins.length} plugins`;
    // The POST stays blocking, so progress rides the track-progress notification alongside it.
    const unsubscribe = this.subscribeStatus('track-progress', (event) => event.trackProgress ?? undefined, options.onProgress);
    try {
      const answer = await this.mutate({
        op: `track(${counted})`,
        failMsg: `Could not track ${counted}`,
        post: () => this.apiClient.POST('/plugins/track', { body: { plugins: [...plugins], preset, upstreamVersionByOrigin } }),
      });
      if (isRefused(answer)) return answer;
      return {
        landed: answer.applied,
        refused: answer.refused.map((r) => ({ item: r.plugin, reason: r.message })),
      };
    } finally {
      unsubscribe();
    }
  }

  async createRecord(plugin: string, origin: string, recordType: string): Promise<RecordCreateResponse | WriteRefused> {
    const failMsg = `Could not create a new ${recordType} record in "${plugin}"`;
    const answer = await this.mutate<RecordCreateResponse>({
      op: `createRecord(${plugin}, ${recordType})`,
      failMsg,
      post: () => this.apiClient.POST('/plugins/{plugin}/records', {
        params: { path: { plugin } },
        body: { origin, recordType, editorId: null, formKey: null },
      }),
    });
    return answer;
  }

  async deleteRecords(records: readonly RecordAddress[]): Promise<SelectionOutcome<RecordAddress> | WriteRefused> {
    const counted = records.length === 1 ? '1 record' : `${records.length} records`;
    const answer = await this.mutate({
      op: `deleteRecords(${counted})`,
      failMsg: `Could not delete ${counted}`,
      post: () => this.apiClient.POST('/records/delete', { body: { records: [...records] } }),
    });
    if (isRefused(answer)) return answer;
    return {
      landed: answer.applied,
      refused: answer.refused.map((r) => ({ item: r.record, reason: r.message })),
    };
  }

  async copyRecords(
    records: readonly RecordAddress[], mode: CopyMode, destinations: readonly PluginAddress[], replace: boolean,
  ): Promise<SelectionOutcome<CopyItem> | WriteRefused> {
    const counted = records.length === 1 ? '1 record' : `${records.length} records`;
    const answer = await this.mutate({
      op: `copyRecords(${counted}, ${mode})`,
      failMsg: `Could not copy ${counted}`,
      post: () => this.apiClient.POST('/records/copy', {
        body: { records: [...records], mode, destinations: [...destinations], replace },
      }),
    });
    if (isRefused(answer)) return answer;
    return {
      landed: answer.applied.map(({ record, destination, newFormKey }) => ({ record, destination, newFormKey })),
      refused: answer.refused.map((r) => ({ item: { record: r.record, destination: r.destination }, reason: r.message })),
    };
  }

  async decompile(plugins: readonly PluginAddress[]): Promise<SelectionOutcome<PluginAddress> | WriteRefused> {
    const counted = plugins.length === 1 ? '1 plugin' : `${plugins.length} plugins`;
    const answer = await this.mutate({
      op: `decompile(${counted})`,
      failMsg: `Could not decompile ${counted}`,
      post: () => this.apiClient.POST('/plugins/decompile', { body: { plugins: [...plugins] } }),
    });
    if (isRefused(answer)) return answer;
    return {
      landed: answer.applied,
      refused: answer.refused.map((r) => ({ item: r.plugin, reason: r.message })),
    };
  }

  /** Each plugin compiles or is refused on its own. A cause no plugin escapes, no load order,
   *  refuses the whole selection. Never refreshes the tree: a compiled binary changes only bytes on
   *  disk. */
  async compile(plugins: readonly PluginAddress[]): Promise<CompileOutcome | WriteRefused> {
    const counted = plugins.length === 1 ? '1 plugin' : `${plugins.length} plugins`;
    const answer = await this.mutate({
      op: `compile(${counted})`,
      failMsg: `Could not compile ${counted}`,
      post: () => this.apiClient.POST('/plugins/compile', {
        body: { plugins: [...plugins] },
      }),
    });
    if (isRefused(answer)) return answer;
    return {
      landed: answer.applied,
      refused: answer.refused.map((r) => ({ item: r.plugin, reason: r.message })),
    };
  }

  /** ADR-0007: the single write path. A refusal (untracked plugin, a link that would dangle) is
   *  an expected answer and comes back typed; only a transport failure rejects. */
  async editRecord(formKey: string, plugin: string, origin: string, envelope: RecordEditEnvelope): Promise<RecordEditOutcome> {
    const spelled = JSON.stringify(envelope.path);
    const { data, error, response } = await this.apiClient.POST('/records/{formKey}/edit', {
      params: { path: { formKey } },
      body: { plugin, origin, ...envelope },
    });
    if (response.ok && data?.applied) return data.newFormKey ? { applied: true, newFormKey: data.newFormKey } : { applied: true };

    // The backend's typed discriminator, off the ProblemDetails extension rather than re-derived
    // from the status: only it tells "not tracked" from "no folder", whose ways out differ.
    // `refusal` reads through ProblemDetails' own index signature — no cast.
    const refusal = error?.refusal;
    const outcome: RecordEditOutcome = {
      applied: false,
      refusal: typeof refusal === 'string' ? refusal : 'Unknown',
      message: error?.detail ?? (errorText(error) || `Edit failed (${response.status}).`),
    };
    this.log(`[HttpMEditClient] editRecord(${formKey} ${envelope.op} ${spelled}) refused: ${outcome.refusal} — ${outcome.message}`);
    return outcome;
  }

  // ── reads ────────────────────────────────────────────────────────────────

  // Never swallow a read failure into an empty list: it would be indistinguishable from
  // genuinely empty data, so the tree could not render an ErrorNode (ADR-0019). A 200 with an
  // absent body is a legitimate empty result.
  private ensureOk(what: string, response: Response, error?: unknown): void {
    if (response.ok) return;
    const text = errorText(error);
    const detail = text ? `: ${text}` : '';
    const msg = `${what} failed (${response.status})${detail}`;
    this.log(`[HttpMEditClient] ${msg}`);
    throw new Error(msg);
  }

  // Races rather than trusting the fetch to honor the signal: a hung backend and an
  // uncooperative test double both still settle the promise. The signal is aborted anyway, so a
  // fetch that honors it cancels for real.
  private async withTimeout<T>(what: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer!: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`${what} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([fn(controller.signal), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  async getPlugins(): Promise<PluginMetadata[]> {
    const { data, error, response } = await this.apiClient.GET('/plugins', {});
    this.ensureOk('GET /plugins', response, error);
    return data ?? [];
  }

  async getDiagnoses(): Promise<PluginDiagnosisReport[]> {
    const { data, error, response } = await this.apiClient.GET('/plugins/diagnoses', {});
    this.ensureOk('GET /plugins/diagnoses', response, error);
    return data ?? [];
  }

  async getRecordTypes(plugin: string, origin: string): Promise<PluginRecordTypeCount[]> {
    return this.withTimeout(`getRecordTypes(${plugin})`, async (signal) => {
      const { data, error, response } = await this.apiClient.GET('/plugins/{plugin}/record-types', {
        params: { path: { plugin }, query: { origin } },
        signal,
      });
      this.ensureOk(`getRecordTypes(${plugin})`, response, error);
      return data ?? [];
    });
  }

  async getCreatableRecordTypes(): Promise<CreatableRecordType[]> {
    return this.withTimeout('getCreatableRecordTypes', async (signal) => {
      const { data, error, response } = await this.apiClient.GET('/record-types/creatable', { signal });
      this.ensureOk('getCreatableRecordTypes', response, error);
      return data ?? [];
    });
  }

  async getLightPluginsSupported(): Promise<boolean> {
    return this.withTimeout('getLightPluginsSupported', async (signal) => {
      const { data, error, response } = await this.apiClient.GET('/plugins/light-plugins-supported', { signal });
      this.ensureOk('getLightPluginsSupported', response, error);
      return data ?? false;
    });
  }

  async getRecords(
    plugin: string, type: string, offset: number, limit: number, origin: string, options?: { unfiltered: boolean },
  ): Promise<RecordPage> {
    return this.withTimeout(`getRecords(${plugin}, ${type})`, async (signal) => {
      const { data, error, response } = await this.apiClient.GET('/records', {
        params: { query: { plugin, type, offset, limit, origin, ...options } },
        signal,
      });
      this.ensureOk(`getRecords(${plugin}, ${type})`, response, error);
      return data ?? { items: [], total: 0 };
    });
  }

  async searchRecords(query: string, validTypes: string[]): Promise<RecordPage> {
    const { data, error, response } = await this.apiClient.GET('/records', {
      params: { query: { search: query, ...(validTypes.length === 1 ? { type: validTypes[0] } : {}), limit: 20 } },
    });
    this.ensureOk(`searchRecords(${query})`, response, error);
    return data ?? { items: [], total: 0 };
  }

  async getRecordOwner(formKey: string): Promise<{ plugin: string; origin: string } | undefined> {
    const { data, error, response } = await this.apiClient.GET('/records/{formKey}', { params: { path: { formKey } } });
    if (response.status === 404) return undefined;
    this.ensureOk(`getRecordOwner(${formKey})`, response, error);
    return data ? { plugin: data.plugin, origin: data.origin } : undefined;
  }

  // A 404 (unknown FormKey) is "nothing holds it yet", not a fault, as getRecordOwner's own 404 is.
  async getRecordHolders(formKey: string): Promise<PluginAddress[]> {
    const { data, error, response } = await this.apiClient.GET('/records/{formKey}/compare', { params: { path: { formKey } } });
    if (response.status === 404) return [];
    this.ensureOk(`getRecordHolders(${formKey})`, response, error);
    return (data?.overrides ?? []).map((o) => ({ name: o.plugin, origin: o.origin }));
  }

  async getComparison(formKey: string): Promise<CompareResult | null> {
    const { data, error, response } = await this.apiClient.GET('/records/{formKey}/compare', { params: { path: { formKey } } });
    if (response.status === 404) return null;
    this.ensureOk(`getComparison(${formKey})`, response, error);
    if (!data) throw new Error(`getComparison(${formKey}): ok response carried no body`);
    return data;
  }

  async getReferences(formKey: string): Promise<ReferenceResult[]> {
    const { data, error, response } = await this.apiClient.GET('/records/{formKey}/references', { params: { path: { formKey } } });
    this.ensureOk(`getReferences(${formKey})`, response, error);
    return data ?? [];
  }

  async setFilter(filter: RecordFilter): Promise<string | null> {
    try {
      const { error, response } = await this.apiClient.POST('/load-order/filter', { body: filter });
      if (!response.ok) {
        const text = errorText(error);
        this.log(`[HttpMEditClient] setFilter failed (${response.status}): ${text}`);
        return text;
      }
      return null;
    } catch (e) {
      this.log(`[HttpMEditClient] setFilter failed: ${errorMessage(e)}`);
      return errorMessage(e);
    }
  }

  async clearFilter(): Promise<string | null> {
    try {
      const { error, response } = await this.apiClient.DELETE('/load-order/filter', {});
      if (!response.ok) {
        const text = errorText(error);
        this.log(`[HttpMEditClient] clearFilter failed (${response.status}): ${text}`);
        return text;
      }
      return null;
    } catch (e) {
      this.log(`[HttpMEditClient] clearFilter failed: ${errorMessage(e)}`);
      return errorMessage(e);
    }
  }

  async getActiveFilter(): Promise<RecordFilter | null> {
    const { data, error, response } = await this.apiClient.GET('/load-order/filter', {});
    this.ensureOk('getActiveFilter', response, error);
    if (data?.sql == null) return null;
    if (data.source == null) throw new Error('mEdit answered a record filter with no source.');
    return { sql: data.sql, source: data.source };
  }

  async getWorldspaces(plugin: string, origin: string): Promise<WorldspaceSummary[]> {
    return this.withTimeout(`getWorldspaces(${plugin})`, async (signal) => {
      const { data, error, response } = await this.apiClient.GET('/plugins/{plugin}/worldspaces', {
        params: { path: { plugin }, query: { origin } },
        signal,
      });
      this.ensureOk(`getWorldspaces(${plugin})`, response, error);
      return data ?? [];
    });
  }

  async getWorldspaceBlocks(plugin: string, worldspaceFormKey: string, origin: string): Promise<WorldspaceBlocks> {
    return this.withTimeout(`getWorldspaceBlocks(${plugin}, ${worldspaceFormKey})`, async (signal) => {
      const { data, error, response } = await this.apiClient.GET('/plugins/{plugin}/worldspaces/{formKey}/blocks', {
        params: { path: { plugin, formKey: worldspaceFormKey }, query: { origin } },
        signal,
      });
      this.ensureOk(`getWorldspaceBlocks(${plugin}, ${worldspaceFormKey})`, response, error);
      return data ?? { topCells: [], blocks: [] };
    });
  }

  async getCellChildRecords(plugin: string, cellFormKey: string, origin: string): Promise<CellChildRecords> {
    return this.withTimeout(`getCellChildRecords(${plugin}, ${cellFormKey})`, async (signal) => {
      const { data, error, response } = await this.apiClient.GET('/plugins/{plugin}/cells/{formKey}/children', {
        params: { path: { plugin, formKey: cellFormKey }, query: { origin } },
        signal,
      });
      this.ensureOk(`getCellChildRecords(${plugin}, ${cellFormKey})`, response, error);
      return data ?? { persistent: [], temporary: [] };
    });
  }

  async getInteriorCells(plugin: string, origin: string): Promise<InteriorCellBlock[]> {
    return this.withTimeout(`getInteriorCells(${plugin})`, async (signal) => {
      const { data, error, response } = await this.apiClient.GET('/plugins/{plugin}/interior-cells', {
        params: { path: { plugin }, query: { origin } },
        signal,
      });
      this.ensureOk(`getInteriorCells(${plugin})`, response, error);
      return data ?? [];
    });
  }

  async getContainerChildren(plugin: string, parentFormKey: string, origin: string): Promise<ContainerChildSummary[]> {
    return this.withTimeout(`getContainerChildren(${plugin}, ${parentFormKey})`, async (signal) => {
      const { data, error, response } = await this.apiClient.GET('/plugins/{plugin}/records/{formKey}/children', {
        params: { path: { plugin, formKey: parentFormKey }, query: { origin } },
        signal,
      });
      this.ensureOk(`getContainerChildren(${plugin}, ${parentFormKey})`, response, error);
      return data ?? [];
    });
  }
}

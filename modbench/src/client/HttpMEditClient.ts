import type { RecordEditEnvelope } from '../wire/messages';
import {
  createApiClient, errorText, isTerminalLoadOrderStatusFor, openNotificationStream,
  toLoadOrderStatus, type ApiClient, type LoadOrderStatus, type CompareResult, type RecordCopy, type CopyText,
} from './apiClient';
import { createUnlimitedFetch } from './unlimitedFetch';
import { bundledBackendPath, spawnPiped } from './bundledBackend';
import { backendLogLevelArgs, makeBackendLogForwarder, type BackendLogChannel } from './backendLog';
import { BackendLifecycle, type BackendLifecycleOptions } from './backendLifecycle';
import { SseNotificationSubscriber } from './notificationStream';
import { createLoadOrderSender, type LoadOrderSender } from './loadOrderSender';
import {
  type BackendStatus, type CellChildRecords, type CompileOutcome,
  type ContainerChildSummary, type InteriorCellBlock, type LaunchOutcome, type LoadOrderOutcome,
  type LoadOrderSnapshot, type LoadOrderProgress, type MEditClient, type NotificationKind, type NotificationPayloads,
  type PluginCreatedResponse, type PluginDiagnosisReport, type PluginMetadata, type PluginRecordTypeCount, type PluginDependants, type PluginProblems, type RecordTypeChoice, type RenderedDocument, type RecordFile,
  type RebuildIndexOutcome, type CopyItem, type CopyMode, type RecordChildHolders,
  type GridPosition, type RecordAddress, type RecordCreateResponse, type RecordEditChangesOutcome, type RecordPage,
  type RecordFilter, type ReferenceResult, type PluginAddress, type TrackStatus, type TrackOutcome,
  type WorldspaceBlocks, type WorldspaceSummary, type WriteRefused, isRefused,
} from './MEditClient';
import { errorMessage } from '../ports/errorMessage';
import type { ItemRefusal, SelectionOutcome } from '../ports/selectionOutcome';

// 30s is an ordinary HTTP-client default. A slow call and a hung one look the same to the tree,
// so nothing tries to tell them apart.
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

interface HttpMEditClientDeps {
  /** The process this client is the front of. It spawns the bundled backend unless told otherwise. */
  backend?: Omit<BackendLifecycleOptions, 'onOutput' | 'serilogLevelArgs' | 'log'>;
  /** Where the spawned backend's output goes, and whose level it is spawned at. */
  backendLog: BackendLogChannel;
  /** Overrides the production fetch (undici, unlimited timeouts) — a test scripts the backend's
   *  HTTP responses through this. */
  fetch?: (input: Request) => Promise<Response>;
  log?: (msg: string) => void;
  timeoutMs?: number;
  reconnectDelayMs?: number;
}

function itemRefusals<R>(refused: { item: R; message: string }[]): ItemRefusal<R>[] {
  return refused.map((r) => ({ item: r.item, reason: r.message }));
}

function selectionOutcome<L, R>(
  answer: { applied: L[]; refused: { item: R; message: string }[] },
): { landed: readonly L[]; refused: readonly ItemRefusal<R>[] } {
  return { landed: answer.applied, refused: itemRefusals(answer.refused) };
}

// The backend's typed discriminator, off the ProblemDetails extension rather than re-derived from the
// status: only it tells "not tracked" from "no folder", whose ways out differ.
function editRefused(
  error: { refusal?: unknown; detail?: string | null } | undefined, status: number,
): { applied: false; refusal: string; message: string } {
  const refusal = error?.refusal;
  return {
    applied: false,
    refusal: typeof refusal === 'string' ? refusal : 'Unknown',
    message: error?.detail ?? (errorText(error) || `Edit failed (${status}).`),
  };
}

function backendOptions(deps: HttpMEditClientDeps): BackendLifecycleOptions {
  return {
    executablePath: bundledBackendPath(process.platform, __dirname),
    spawn: spawnPiped,
    ...deps.backend,
    log: deps.log,
    onOutput: makeBackendLogForwarder(deps.backendLog),
    serilogLevelArgs: () => backendLogLevelArgs(deps.backendLog.logLevel),
  };
}

class HttpMEditClient implements MEditClient {
  private api?: { port: number; client: ApiClient };
  private readonly fetchImpl: (input: Request) => Promise<Response>;
  private readonly log: (msg: string) => void;
  private readonly timeoutMs: number;
  private readonly lifecycle: BackendLifecycle;
  private readonly notifications: SseNotificationSubscriber;
  private readonly loadOrder: LoadOrderSender;
  constructor(deps: HttpMEditClientDeps) {
    this.log = deps.log ?? (() => {});
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    this.fetchImpl = deps.fetch ?? createUnlimitedFetch();
    this.notifications = new SseNotificationSubscriber({
      openStream: (signal) => openNotificationStream(this.apiClient, signal),
      log: deps.log,
      reconnectDelayMs: deps.reconnectDelayMs,
    });
    this.lifecycle = new BackendLifecycle(backendOptions(deps));
    // The stream is open exactly while the backend is attached, so no module outside this one
    // starts or stops it.
    this.lifecycle.onStatusChanged((status) => {
      if (status === 'running') this.notifications.start();
      else this.notifications.stop();
    });
    this.loadOrder = createLoadOrderSender({
      status: () => this.lifecycle.status,
      starting: () => this.lifecycle.starting,
      onStatusChanged: (listener) => this.lifecycle.onStatusChanged(listener),
      onReconnected: (listener) => this.notifications.onReconnected(listener),
      start: () => this.lifecycle.start(),
      stop: () => this.lifecycle.stop(),
      put: (snapshot, signal) => this.putLoadOrder(snapshot, signal),
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
  async start(): Promise<void> { await this.loadOrder.launch(); }
  onLaunch(listener: (launched: Promise<LaunchOutcome>) => void): () => void { return this.loadOrder.onLaunch(listener); }
  stop(): Promise<void> { return this.loadOrder.stop(); }

  sendLoadOrder(snapshot: LoadOrderSnapshot): Promise<LoadOrderOutcome> { return this.loadOrder.send(snapshot); }
  latestLoadOrder(): Promise<LoadOrderOutcome | undefined> { return this.loadOrder.latest(); }
  onLoadOrderResent(listener: (snapshot: LoadOrderSnapshot, outcome: LoadOrderOutcome) => void): () => void {
    return this.loadOrder.onResent(listener);
  }

  // ── notifications ────────────────────────────────────────────────────────

  onNotification<K extends NotificationKind>(kind: K, listener: (payload: NotificationPayloads[K]) => void): () => void {
    return this.notifications.onNotification(kind, listener);
  }

  // ── writes ───────────────────────────────────────────────────────────────

  // Every write verb below shares this shape: POST, map a non-ok response or a thrown request
  // onto WriteRefused, otherwise hand back the wire data untouched. No refresh, no toast — the
  // caller does both, from what this returns.
  private async mutate<T>(spec: {
    op: string;
    failMsg: string;
    post: () => Promise<{ data?: T; error?: unknown; response: { ok: boolean; status: number } }>;
    /** What a 2xx with no body answers. */
    noContent?: T;
  }): Promise<T | WriteRefused> {
    try {
      const { data, error, response } = await spec.post();
      if (!response.ok) {
        const text = errorText(error);
        this.log(`[HttpMEditClient] ${spec.op} failed (${response.status}): ${text}`);
        return { refused: true, message: `${spec.failMsg} — ${text}` };
      }
      return data ?? spec.noContent ?? { refused: true, message: `${spec.failMsg} — no answer` };
    } catch (e) {
      const message = errorMessage(e);
      this.log(`[HttpMEditClient] ${spec.op} threw: ${message}`);
      return { refused: true, message: `${spec.failMsg} — ${message}` };
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

  async renameSource(plugin: PluginAddress, newName: string): Promise<{ renamed: true } | WriteRefused> {
    return this.mutate({
      op: `renameSource(${plugin.name}, ${plugin.origin})`,
      failMsg: `Could not rename the source of "${plugin.name}"`,
      post: () => this.apiClient.POST('/plugins/rename-source', { body: { origin: plugin.origin, name: plugin.name, newName } }),
      noContent: { renamed: true },
    });
  }

  /** Refresh's first step (commands.md, Instance), which refills the index against the load order
   *  mEdit holds. A 423 is `heldElsewhere` (ADR-0010), never a rejection. */
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

  // `instanceRoot` scopes the backend's index (ADR-0010). The signal aborts the PUT itself rather
  // than leaving it to notice a dead socket.
  private async putLoadOrder(snapshot: LoadOrderSnapshot, signal: AbortSignal): Promise<LoadOrderOutcome> {
    const { plugins, active, loadedWithNoLine, gameDirectory, instanceRoot, gameRelease } = snapshot;
    // The backend publishes its first tick as this PUT lands, so a PUT that outran the stream
    // loses every tick published before it connects — and with them the progressive chevrons.
    await this.notifications.whenConnected();

    let resolveTerminal!: (status: LoadOrderProgress) => void;
    const terminal = new Promise<LoadOrderProgress>((resolve) => { resolveTerminal = resolve; });
    // A box, not a `let`: the subscriber below closes over it before this call's own PUT answers
    // with the version it holds.
    const applying: { version?: number; latest?: LoadOrderStatus } = {};
    const unsubscribe = this.notifications.onNotification('load-order-status', (status) => {
      applying.latest = status;
      if (applying.version !== undefined && isTerminalLoadOrderStatusFor(status, applying.version)) resolveTerminal(status);
    });

    let result;
    try {
      result = await this.apiClient.PUT('/load-order', {
        body: { plugins, active, loadedWithNoLine, gameDirectory, instanceRoot, gameRelease },
        signal,
      });
    } catch (e) {
      unsubscribe();
      if (this.wasDeliberatelyAborted(signal)) return { outcome: 'abandoned' };
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
    const status = await this.awaitTerminalOrAbort(terminal, signal);
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
    terminal: Promise<LoadOrderProgress>, signal: AbortSignal,
  ): Promise<LoadOrderProgress | undefined> {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (status: LoadOrderProgress | undefined): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        unlisten();
        resolve(status);
      };
      const onAbort = (): void => settle(undefined);
      signal.addEventListener('abort', onAbort, { once: true });
      const unlisten = this.lifecycle.onStatusChanged((status) => {
        if (status !== 'running') settle(undefined);
      });
      void terminal.then(settle);
    });
  }

  // An abort is the one rejection that is not a failure: the teardown is already underway.
  private wasDeliberatelyAborted(signal: AbortSignal): boolean {
    if (!signal.aborted) return false;
    this.log('[HttpMEditClient] putLoadOrder was aborted — mEdit was closed while it reconciled');
    return true;
  }

  /** ADR-0007; commands.md, A selection is one gesture, and each item lands on its own. */
  async track(
    mods: readonly string[], options: { onProgress?: (status: TrackStatus) => void } = {},
  ): Promise<TrackOutcome | WriteRefused> {
    const counted = mods.length === 1 ? '1 mod' : `${mods.length} mods`;
    // The POST stays blocking, so progress rides the track-progress notification alongside it.
    const unsubscribe = options.onProgress ? this.notifications.onNotification('track-progress', options.onProgress) : () => {};
    try {
      const answer = await this.mutate({
        op: `track(${counted})`,
        failMsg: `Could not track ${counted}`,
        post: () => this.apiClient.POST('/plugins/track', { body: { mods: [...mods] } }),
      });
      if (isRefused(answer)) return answer;
      return selectionOutcome({
        applied: answer.applied.map((m) => ({ mod: m.mod, tracked: m.tracked })),
        refused: answer.refused,
      });
    } finally {
      unsubscribe();
    }
  }

  async createRecord(
    { name: plugin, origin }: PluginAddress, recordType: string, into?: { container?: string; position?: GridPosition },
  ): Promise<RecordCreateResponse | WriteRefused> {
    const failMsg = `Could not create a new ${recordType} record in "${plugin}"`;
    const answer = await this.mutate<RecordCreateResponse>({
      op: `createRecord(${plugin}, ${recordType})`,
      failMsg,
      post: () => this.apiClient.POST('/plugins/{plugin}/records', {
        params: { path: { plugin } },
        body: { origin, recordType, ...into },
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
    return isRefused(answer) ? answer : selectionOutcome(answer);
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
    return isRefused(answer) ? answer : selectionOutcome(answer);
  }

  async decompile(plugins: readonly PluginAddress[]): Promise<SelectionOutcome<PluginAddress> | WriteRefused> {
    const counted = plugins.length === 1 ? '1 plugin' : `${plugins.length} plugins`;
    const answer = await this.mutate({
      op: `decompile(${counted})`,
      failMsg: `Could not decompile ${counted}`,
      post: () => this.apiClient.POST('/plugins/decompile', { body: { plugins: [...plugins] } }),
    });
    return isRefused(answer) ? answer : selectionOutcome(answer);
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
    return isRefused(answer) ? answer : selectionOutcome(answer);
  }

  /** A refusal (untracked plugin, a link that would dangle) comes back typed (ADR-0014); only a
   *  transport failure rejects. */
  async getEditChanges(
    formKey: string, { name: plugin, origin }: PluginAddress, envelope: RecordEditEnvelope, text: string,
  ): Promise<RecordEditChangesOutcome> {
    const { data, error, response } = await this.apiClient.POST('/records/{formKey}/edit-changes', {
      params: { path: { formKey } },
      body: { edit: { plugin, origin, ...envelope }, text },
    });
    if (response.ok && data) {
      const { moves, documents, newFormKey } = data;
      return newFormKey ? { applied: true, moves, documents, newFormKey } : { applied: true, moves, documents };
    }

    const outcome = editRefused(error, response.status);
    this.log(`[HttpMEditClient] getEditChanges(${formKey} ${envelope.op} ${JSON.stringify(envelope.path)}) refused: ${outcome.refusal} — ${outcome.message}`);
    return outcome;
  }

  // ── reads ────────────────────────────────────────────────────────────────

  // A read failure throws, never an empty list, so the tree renders its error row (common.md,
  // States, story 2). A 200 with an absent body is a legitimate empty result.
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

  async getPluginDependants({ name: plugin, origin }: PluginAddress): Promise<PluginDependants> {
    return this.withTimeout(`getPluginDependants(${plugin})`, async (signal) => {
      const { data, error, response } = await this.apiClient.GET('/plugins/{plugin}/dependants', {
        params: { path: { plugin }, query: { origin } },
        signal,
      });
      this.ensureOk(`getPluginDependants(${plugin})`, response, error);
      if (data === undefined) throw new Error(`mEdit gave no answer for getPluginDependants(${plugin})`);
      return data;
    });
  }

  async getPluginProblems(): Promise<PluginProblems[]> {
    return this.withTimeout('getPluginProblems', async (signal) => {
      const { data, error, response } = await this.apiClient.GET('/plugins/problems', { signal });
      this.ensureOk('getPluginProblems', response, error);
      if (data === undefined) throw new Error('mEdit gave no answer for getPluginProblems');
      return data;
    });
  }

  async getRecordTypes({ name: plugin, origin }: PluginAddress): Promise<PluginRecordTypeCount[]> {
    return this.withTimeout(`getRecordTypes(${plugin})`, async (signal) => {
      const { data, error, response } = await this.apiClient.GET('/plugins/{plugin}/record-types', {
        params: { path: { plugin }, query: { origin } },
        signal,
      });
      this.ensureOk(`getRecordTypes(${plugin})`, response, error);
      return data ?? [];
    });
  }

  async getCreatableRecordTypes(): Promise<RecordTypeChoice[]> {
    return this.withTimeout('getCreatableRecordTypes', async (signal) => {
      const { data, error, response } = await this.apiClient.GET('/record-types/creatable', { signal });
      this.ensureOk('getCreatableRecordTypes', response, error);
      return data ?? [];
    });
  }

  async getChildRecordTypes({ name: plugin, origin }: PluginAddress, formKey: string): Promise<RecordTypeChoice[]> {
    return this.withTimeout(`getChildRecordTypes(${plugin}, ${formKey})`, async (signal) => {
      const { data, error, response } = await this.apiClient.GET('/plugins/{plugin}/records/{formKey}/child-record-types', {
        params: { path: { plugin, formKey }, query: { origin } },
        signal,
      });
      this.ensureOk(`getChildRecordTypes(${plugin}, ${formKey})`, response, error);
      return data ?? [];
    });
  }

  async getCreatablePluginExtensions(): Promise<string[]> {
    return this.withTimeout('getCreatablePluginExtensions', async (signal) => {
      const { data, error, response } = await this.apiClient.GET('/plugins/creatable-extensions', { signal });
      this.ensureOk('getCreatablePluginExtensions', response, error);
      return data ?? [];
    });
  }

  async getRecords({ name: plugin, origin }: PluginAddress, type: string, offset: number, limit: number): Promise<RecordPage> {
    return this.withTimeout(`getRecords(${plugin}, ${type})`, async (signal) => {
      const { data, error, response } = await this.apiClient.GET('/records', {
        params: { query: { plugin, type: [type], offset, limit, origin } },
        signal,
      });
      this.ensureOk(`getRecords(${plugin}, ${type})`, response, error);
      return data ?? { items: [], total: 0 };
    });
  }

  async searchRecords(query: string, validTypes: string[], plugin?: PluginAddress): Promise<RecordPage> {
    const { data, error, response } = await this.apiClient.GET('/records', {
      params: { query: {
        search: query, ...(validTypes.length > 0 ? { type: validTypes } : {}), limit: 20,
        ...(plugin && { plugin: plugin.name, origin: plugin.origin }),
      } },
    });
    this.ensureOk(`searchRecords(${query})`, response, error);
    return data ?? { items: [], total: 0 };
  }

  async getRecordOwner(formKey: string): Promise<PluginAddress | undefined> {
    const { data, error, response } = await this.apiClient.GET('/records/{formKey}', { params: { path: { formKey } } });
    if (response.status === 404) return undefined;
    this.ensureOk(`getRecordOwner(${formKey})`, response, error);
    return data ? { name: data.plugin, origin: data.origin } : undefined;
  }

  // A 404 (unknown FormKey) is "nothing holds it yet", not a fault, as getRecordOwner's own 404 is.
  async getRecordHolders(formKey: string): Promise<PluginAddress[]> {
    const { data, error, response } = await this.apiClient.GET('/records/{formKey}/compare', { params: { path: { formKey } } });
    if (response.status === 404) return [];
    this.ensureOk(`getRecordHolders(${formKey})`, response, error);
    return (data?.overrides ?? []).map((o) => ({ name: o.plugin, origin: o.origin }));
  }

  async getRecordsWithChildren(records: readonly RecordAddress[]): Promise<RecordAddress[]> {
    const { data, error, response } = await this.apiClient.POST('/records/with-children', { body: { records: [...records] } });
    this.ensureOk('getRecordsWithChildren', response, error);
    return data ?? [];
  }

  async getChildrenInDestinations(
    records: readonly RecordAddress[], destinations: readonly PluginAddress[],
  ): Promise<RecordChildHolders[]> {
    const { data, error, response } = await this.apiClient.POST('/records/children-in-destinations', {
      body: { records: [...records], destinations: [...destinations] },
    });
    this.ensureOk('getChildrenInDestinations', response, error);
    return data ?? [];
  }

  async getComparison(formKey: string, text?: CopyText): Promise<CompareResult | null> {
    const params = { params: { path: { formKey } } };
    const { data, error, response } = text
      ? await this.apiClient.POST('/records/{formKey}/compare', { ...params, body: text })
      : await this.apiClient.GET('/records/{formKey}/compare', params);
    if (response.status === 404) return null;
    this.ensureOk(`getComparison(${formKey})`, response, error);
    if (!data) throw new Error(`getComparison(${formKey}): ok response carried no body`);
    return data;
  }

  async getRecordsComparison(copies: RecordCopy[]): Promise<CompareResult | null> {
    const { data, error, response } = await this.apiClient.POST('/records/compare', { body: { copies } });
    if (response.status === 404) return null;
    this.ensureOk('getRecordsComparison', response, error);
    if (!data) throw new Error('getRecordsComparison: ok response carried no body');
    return data;
  }

  async getReferences(formKey: string): Promise<ReferenceResult[]> {
    const { data, error, response } = await this.apiClient.GET('/records/{formKey}/references', { params: { path: { formKey } } });
    this.ensureOk(`getReferences(${formKey})`, response, error);
    return data ?? [];
  }

  async getRenderedDocument({ name: plugin, origin }: PluginAddress, formKey: string): Promise<RenderedDocument | null> {
    return this.withTimeout(`getRenderedDocument(${plugin}, ${formKey})`, async (signal) => {
      const { data, error, response } = await this.apiClient.GET('/plugins/{plugin}/records/{formKey}/rendered-document', {
        params: { path: { plugin, formKey }, query: { origin } },
        signal,
      });
      if (response.status === 404) return null;
      this.ensureOk(`getRenderedDocument(${plugin}, ${formKey})`, response, error);
      if (!data) throw new Error(`getRenderedDocument(${plugin}, ${formKey}): ok response carried no body`);
      return data;
    });
  }

  async getRecordFile({ name: plugin, origin }: PluginAddress, formKey: string): Promise<RecordFile | null> {
    return this.withTimeout(`getRecordFile(${plugin}, ${formKey})`, async (signal) => {
      const { data, error, response } = await this.apiClient.GET('/plugins/{plugin}/records/{formKey}/file', {
        params: { path: { plugin, formKey }, query: { origin } },
        signal,
      });
      if (response.status === 404) return null;
      this.ensureOk(`getRecordFile(${plugin}, ${formKey})`, response, error);
      if (!data) throw new Error(`getRecordFile(${plugin}, ${formKey}): ok response carried no body`);
      return data;
    });
  }

  async getRecordOfFile(path: string): Promise<RecordAddress | null> {
    return this.withTimeout(`getRecordOfFile(${path})`, async (signal) => {
      const { data, error, response } = await this.apiClient.GET('/plugin-source/record', { params: { query: { path } }, signal });
      if (response.status === 204) return null;
      this.ensureOk(`getRecordOfFile(${path})`, response, error);
      if (!data) throw new Error(`getRecordOfFile(${path}): ok response carried no body`);
      return data;
    });
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

  async getWorldspaces({ name: plugin, origin }: PluginAddress): Promise<WorldspaceSummary[]> {
    return this.withTimeout(`getWorldspaces(${plugin})`, async (signal) => {
      const { data, error, response } = await this.apiClient.GET('/plugins/{plugin}/worldspaces', {
        params: { path: { plugin }, query: { origin } },
        signal,
      });
      this.ensureOk(`getWorldspaces(${plugin})`, response, error);
      return data ?? [];
    });
  }

  async getWorldspaceBlocks({ name: plugin, origin }: PluginAddress, worldspaceFormKey: string): Promise<WorldspaceBlocks> {
    return this.withTimeout(`getWorldspaceBlocks(${plugin}, ${worldspaceFormKey})`, async (signal) => {
      const { data, error, response } = await this.apiClient.GET('/plugins/{plugin}/worldspaces/{formKey}/blocks', {
        params: { path: { plugin, formKey: worldspaceFormKey }, query: { origin } },
        signal,
      });
      this.ensureOk(`getWorldspaceBlocks(${plugin}, ${worldspaceFormKey})`, response, error);
      return data ?? { topCells: [], blocks: [] };
    });
  }

  async getCellChildRecords({ name: plugin, origin }: PluginAddress, cellFormKey: string): Promise<CellChildRecords> {
    return this.withTimeout(`getCellChildRecords(${plugin}, ${cellFormKey})`, async (signal) => {
      const { data, error, response } = await this.apiClient.GET('/plugins/{plugin}/cells/{formKey}/children', {
        params: { path: { plugin, formKey: cellFormKey }, query: { origin } },
        signal,
      });
      this.ensureOk(`getCellChildRecords(${plugin}, ${cellFormKey})`, response, error);
      return data ?? { persistent: [], temporary: [] };
    });
  }

  async getInteriorCells({ name: plugin, origin }: PluginAddress): Promise<InteriorCellBlock[]> {
    return this.withTimeout(`getInteriorCells(${plugin})`, async (signal) => {
      const { data, error, response } = await this.apiClient.GET('/plugins/{plugin}/interior-cells', {
        params: { path: { plugin }, query: { origin } },
        signal,
      });
      this.ensureOk(`getInteriorCells(${plugin})`, response, error);
      return data ?? [];
    });
  }

  async getContainerChildren({ name: plugin, origin }: PluginAddress, parentFormKey: string): Promise<ContainerChildSummary[]> {
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

export function createMEditClient(deps: HttpMEditClientDeps): MEditClient {
  return new HttpMEditClient(deps);
}

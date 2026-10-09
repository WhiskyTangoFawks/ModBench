import type { RecordEditEnvelope } from '../wire/messages';
import {
  createApiClient, errorText, isTerminalLoadOrderStatusFor, openNotificationStream,
  toLoadOrderStatus, type ApiClient, type LoadOrderStatus, type CompareResult, type CompareRecordsResponse, type RecordCopy, type CopyText,
} from './apiClient';
import { createUnlimitedFetch } from './unlimitedFetch';
import { bundledBackendPath, spawnPiped } from './bundledBackend';
import { backendLogLevelArgs, makeBackendLogForwarder, type BackendLogChannel } from './backendLog';
import { BackendLifecycle, type BackendLifecycleOptions } from './backendLifecycle';
import { SseNotificationSubscriber } from './notificationStream';
import { createLoadOrderSender, type LoadOrderSender } from './loadOrderSender';
import { createUnsavedHandOver, type UnsavedHandOver } from './unsavedHandOver';
import { keepLoadOrderStatus, type LoadOrderStatusKeeper } from './loadOrderStatusKeeper';
import {
  type BackendStatus, type CellChildRecords, type CompileOutcome,
  type ContainerChildSummary, type InteriorCellBlock, type LaunchOutcome, type LoadOrderOutcome,
  type LoadOrderSnapshot, type LoadOrderProgress, type MEditClient, type NotificationKind, type NotificationPayloads,
  type PluginCreatedResponse, type PluginDiagnosisReport, type PluginMetadata, type PluginRecordTypeCount, type PluginDependants, type PluginProblems, type RecordTypeChoice, type RenderedDocument, type CopyDocument,
  type RebuildIndexOutcome, type CopyChangesOutcome, type CopyMode,
  type GridPosition, type RecordAddress, type CreateChangesOutcome, type RecordEditChangesOutcome, type RecordPage, type DeleteChangesOutcome, type UnsavedDocument, type RenameSourceChangesOutcome,
  type RecordFilter, type ReferenceResult, type PluginAddress, type TrackStatus, type TrackOutcome,
  type WorkingTreeStatesBeneath, type WorldspaceBlocks, type WorldspaceSummary, type WriteRefused, isRefused,
} from './MEditClient';
import { errorMessage } from '../ports/errorMessage';
import { failureReason, isReadFailed, type ReadFailed } from '../wire/readFailed';
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
  error: { refusal?: unknown; detail?: string | null } | undefined,
): { applied: false; refusal: string; message: string } {
  const refusal = error?.refusal;
  return {
    applied: false,
    refusal: typeof refusal === 'string' ? refusal : 'Unknown',
    message: error?.detail ?? (errorText(error) || 'mEdit refused the edit.'),
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
  private readonly loadOrderStatusKept: LoadOrderStatusKeeper;
  private readonly handOver: UnsavedHandOver;
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
    this.loadOrderStatusKept = keepLoadOrderStatus(this);
    this.loadOrder = createLoadOrderSender({
      status: () => this.lifecycle.status,
      onStatusChanged: (listener) => this.lifecycle.onStatusChanged(listener),
      onReconnected: (listener) => this.notifications.onReconnected(listener),
      start: () => this.lifecycle.start(),
      stop: () => this.lifecycle.stop(),
      put: (snapshot, signal) => this.putLoadOrder(snapshot, signal),
    });
    this.handOver = createUnsavedHandOver({
      status: () => this.lifecycle.status,
      onStatusChanged: (listener) => this.lifecycle.onStatusChanged(listener),
      onReconnected: (listener) => this.notifications.onReconnected(listener),
      put: (documents) => this.putUnsavedDocuments(documents),
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
  onExit(listener: () => void): () => void { return this.loadOrder.onExit(listener); }
  stop(): Promise<void> { return this.loadOrder.stop(); }

  get loadOrderStatus(): LoadOrderStatus | undefined { return this.loadOrderStatusKept.current(); }
  onLoadOrderStatus(listener: (status: LoadOrderStatus | undefined) => void): () => void {
    return this.loadOrderStatusKept.onStatus(listener);
  }
  onLoadOrderSettled(listener: (status: LoadOrderStatus) => void): () => void {
    return this.loadOrderStatusKept.onSettled(listener);
  }

  sendLoadOrder(snapshot: LoadOrderSnapshot): Promise<LoadOrderOutcome> { return this.loadOrder.send(snapshot); }
  latestLoadOrder(): Promise<LoadOrderOutcome | undefined> { return this.loadOrder.latest(); }
  onLoadOrderResent(listener: (snapshot: LoadOrderSnapshot, outcome: LoadOrderOutcome) => void): () => void {
    return this.loadOrder.onResent(listener);
  }

  handUnsavedDocuments(documents: readonly UnsavedDocument[]): void { this.handOver.hand(documents); }
  onUnsavedHandOver(listener: (failure: ReadFailed | undefined) => void): () => void { return this.handOver.onSettled(listener); }

  private putUnsavedDocuments(documents: readonly UnsavedDocument[]): Promise<ReadFailed | undefined> {
    return this.read('putUnsavedDocuments', (signal) => this.apiClient.PUT('/unsaved-documents', { body: { documents: [...documents] }, signal }), () => undefined);
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
      await this.handOver.sent();
      const { data, error, response } = await spec.post();
      if (!response.ok) {
        const text = errorText(error);
        this.log(`[HttpMEditClient] ${spec.op} failed (${response.status}): ${text}`);
        return { refused: true, message: `${spec.failMsg} — ${text}` };
      }
      return data ?? spec.noContent ?? { refused: true, message: `${spec.failMsg} — no answer` };
    } catch (e) {
      this.log(`[HttpMEditClient] ${spec.op} threw: ${errorMessage(e)}`);
      return { refused: true, message: `${spec.failMsg} — ${failureReason(UNREACHABLE)}` };
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

  async getRenameSourceChanges(
    plugin: PluginAddress, newName: string,
  ): Promise<RenameSourceChangesOutcome | WriteRefused> {
    return this.mutate<RenameSourceChangesOutcome>({
      op: `getRenameSourceChanges(${plugin.name}, ${plugin.origin})`,
      failMsg: `Could not rename the source of "${plugin.name}"`,
      post: () => this.apiClient.POST('/plugins/rename-source-changes', {
        body: { origin: plugin.origin, name: plugin.name, newName },
      }),
    });
  }

  async moveLastWritten(plugin: PluginAddress, treeName: string, newName: string): Promise<{ moved: true } | WriteRefused> {
    return this.mutate({
      op: `moveLastWritten(${plugin.name}, ${plugin.origin})`,
      failMsg: `Could not move what Modbench last wrote for "${plugin.name}"`,
      post: () => this.apiClient.POST('/plugins/move-last-written', { body: { origin: plugin.origin, name: plugin.name, treeName, newName } }),
      noContent: { moved: true },
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
      this.log(`[HttpMEditClient] rebuildIndex threw: ${errorMessage(e)}`);
      return { rebuilt: false, heldElsewhere: false, detail: failureReason(UNREACHABLE) };
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

  async getCreateChanges(
    { name: plugin, origin }: PluginAddress, recordType: string,
    into?: { container?: string; position?: GridPosition },
  ): Promise<CreateChangesOutcome | WriteRefused> {
    return this.mutate<CreateChangesOutcome>({
      op: `getCreateChanges(${plugin}, ${recordType})`,
      failMsg: `Could not create a new ${recordType} record in "${plugin}"`,
      post: () => this.apiClient.POST('/plugins/{plugin}/create-record-changes', {
        params: { path: { plugin } },
        body: { origin, recordType, ...into },
      }),
    });
  }

  async getDeleteChanges(
    records: readonly RecordAddress[],
  ): Promise<DeleteChangesOutcome | WriteRefused> {
    const counted = records.length === 1 ? '1 record' : `${records.length} records`;
    const answer = await this.mutate({
      op: `getDeleteChanges(${counted})`,
      failMsg: `Could not delete ${counted}`,
      post: () => this.apiClient.POST('/records/delete-changes', { body: { records: [...records] } }),
    });
    return isRefused(answer) ? answer : { applied: answer.applied, refused: itemRefusals(answer.refused) };
  }

  async getCopyChanges(
    records: readonly RecordAddress[], mode: CopyMode, destinations: readonly PluginAddress[], replace: boolean,
  ): Promise<CopyChangesOutcome | WriteRefused> {
    const counted = records.length === 1 ? '1 record' : `${records.length} records`;
    const answer = await this.mutate({
      op: `getCopyChanges(${counted}, ${mode})`,
      failMsg: `Could not copy ${counted}`,
      post: () => this.apiClient.POST('/records/copy-changes', {
        body: { records: [...records], mode, destinations: [...destinations], replace },
      }),
    });
    return isRefused(answer) ? answer : { applied: answer.applied, refused: itemRefusals(answer.refused) };
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
    formKey: string, { name: plugin, origin }: PluginAddress, envelope: RecordEditEnvelope,
  ): Promise<RecordEditChangesOutcome> {
    await this.handOver.sent();
    let result;
    try {
      result = await this.apiClient.POST('/records/{formKey}/edit-changes', {
        params: { path: { formKey } },
        body: { edit: { plugin, origin, ...envelope } },
      });
    } catch (e) {
      this.log(`[HttpMEditClient] getEditChanges(${formKey}) threw: ${errorMessage(e)}`);
      throw new Error(failureReason(UNREACHABLE));
    }
    const { data, error, response } = result;
    if (response.ok && data) {
      const { moves, deletions, documents, newFormKey } = data;
      return newFormKey ? { applied: true, moves, deletions, documents, newFormKey } : { applied: true, moves, deletions, documents };
    }

    const outcome = editRefused(error);
    this.log(`[HttpMEditClient] getEditChanges(${formKey} ${envelope.op} ${JSON.stringify(envelope.path)}) refused: ${outcome.refusal} — ${outcome.message}`);
    return outcome;
  }

  // ── reads ────────────────────────────────────────────────────────────────

  // A read that does not land answers a ReadFailed, never an empty list (common.md, States, story 2).
  // The transport's verb, path and status go to the log alone (ADR-0019).
  private async read<D, A>(
    what: string,
    call: (signal: AbortSignal) => Promise<{ data?: D; error?: unknown; response: Response }>,
    answer: (data: D | undefined) => A | ReadFailed,
    { timed = false, absent }: { timed?: boolean; absent?: { status: number; answers: A } } = {},
  ): Promise<A | ReadFailed> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = call(controller.signal).then(({ data, error, response }): A | ReadFailed => {
      if (absent && response.status === absent.status) return absent.answers;
      if (!response.ok) {
        const text = errorText(error);
        this.log(`[HttpMEditClient] ${what} failed (${response.status})${text ? `: ${text}` : ''}`);
        return text ? { failed: 'refused', refusal: text } : NO_ANSWER;
      }
      const answered = answer(data);
      if (isReadFailed(answered)) this.log(`[HttpMEditClient] ${what}: mEdit answered with no body`);
      return answered;
    }, (e: unknown): ReadFailed => {
      this.log(`[HttpMEditClient] ${what} threw: ${errorMessage(e)}`);
      return UNREACHABLE;
    });
    if (!timed) return settled;
    // Races rather than trusting the fetch to honor the signal: a hung backend and an
    // uncooperative test double both still settle. The signal is aborted anyway, so a fetch that
    // honors it cancels for real.
    const deadline = new Promise<ReadFailed>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        this.log(`[HttpMEditClient] ${what} timed out after ${this.timeoutMs}ms`);
        resolve({ failed: 'timed-out' });
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([settled, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  getPlugins(): Promise<PluginMetadata[] | ReadFailed> {
    return this.read('GET /plugins', (signal) => this.apiClient.GET('/plugins', { signal }), (data) => data ?? []);
  }

  getDiagnoses(): Promise<PluginDiagnosisReport[] | ReadFailed> {
    return this.read('GET /plugins/diagnoses', (signal) => this.apiClient.GET('/plugins/diagnoses', { signal }), (data) => data ?? []);
  }

  getPluginDependants({ name: plugin, origin }: PluginAddress): Promise<PluginDependants | ReadFailed> {
    return this.read(`getPluginDependants(${plugin})`, (signal) => this.apiClient.GET('/plugins/{plugin}/dependants', {
      params: { path: { plugin }, query: { origin } }, signal,
    }), noBodyFails, { timed: true });
  }

  getPluginProblems(): Promise<PluginProblems[] | ReadFailed> {
    return this.read('getPluginProblems', (signal) => this.apiClient.GET('/plugins/problems', { signal }), noBodyFails, { timed: true });
  }

  getRecordTypes({ name: plugin, origin }: PluginAddress): Promise<PluginRecordTypeCount[] | ReadFailed> {
    return this.read(`getRecordTypes(${plugin})`, (signal) => this.apiClient.GET('/plugins/{plugin}/record-types', {
      params: { path: { plugin }, query: { origin } }, signal,
    }), (data) => data ?? [], { timed: true });
  }

  getWorkingTreeStatesBeneath({ name: plugin, origin }: PluginAddress): Promise<WorkingTreeStatesBeneath | ReadFailed> {
    return this.read(`getWorkingTreeStatesBeneath(${plugin})`, (signal) => this.apiClient.GET('/plugins/{plugin}/working-tree-states-beneath', {
      params: { path: { plugin }, query: { origin } }, signal,
    }), noBodyFails, { timed: true });
  }

  getCreatableRecordTypes(): Promise<RecordTypeChoice[] | ReadFailed> {
    return this.read('getCreatableRecordTypes', (signal) => this.apiClient.GET('/record-types/creatable', { signal }), (data) => data ?? [], { timed: true });
  }

  getChildRecordTypes({ name: plugin, origin }: PluginAddress, formKey: string): Promise<RecordTypeChoice[] | ReadFailed> {
    return this.read(`getChildRecordTypes(${plugin}, ${formKey})`, (signal) => this.apiClient.GET('/plugins/{plugin}/records/{formKey}/child-record-types', {
      params: { path: { plugin, formKey }, query: { origin } }, signal,
    }), (data) => data ?? [], { timed: true });
  }

  getCreatablePluginExtensions(): Promise<string[] | ReadFailed> {
    return this.read('getCreatablePluginExtensions', (signal) => this.apiClient.GET('/plugins/creatable-extensions', { signal }), (data) => data ?? [], { timed: true });
  }

  getRecords({ name: plugin, origin }: PluginAddress, type: string, offset: number, limit: number): Promise<RecordPage | ReadFailed> {
    return this.read(`getRecords(${plugin}, ${type})`, (signal) => this.apiClient.GET('/records', {
      params: { query: { plugin, type: [type], offset, limit, origin } }, signal,
    }), (data) => data ?? { items: [], total: 0 }, { timed: true });
  }

  searchRecords(query: string, validTypes: string[], plugin?: PluginAddress): Promise<RecordPage | ReadFailed> {
    return this.read(`searchRecords(${query})`, (signal) => this.apiClient.GET('/records', {
      params: { query: {
        search: query, ...(validTypes.length > 0 ? { type: validTypes } : {}), limit: 20,
        ...(plugin && { plugin: plugin.name, origin: plugin.origin }),
      } },
      signal,
    }), (data) => data ?? { items: [], total: 0 });
  }

  getRecordOwner(formKey: string): Promise<PluginAddress | undefined | ReadFailed> {
    return this.read(`getRecordOwner(${formKey})`, (signal) => this.apiClient.GET('/records/{formKey}', { params: { path: { formKey } }, signal }),
      (data) => (data ? { name: data.plugin, origin: data.origin } : undefined), { absent: { status: 404, answers: undefined } });
  }

  // A 404 (unknown FormKey) is "nothing holds it yet", not a fault, as getRecordOwner's own 404 is.
  getRecordHolders(formKey: string): Promise<PluginAddress[] | ReadFailed> {
    return this.read(`getRecordHolders(${formKey})`, (signal) => this.apiClient.GET('/records/{formKey}/compare', { params: { path: { formKey } }, signal }),
      (data) => (data?.overrides ?? []).map((o) => ({ name: o.plugin, origin: o.origin })), { absent: { status: 404, answers: [] } });
  }

  getComparison(formKey: string, text?: CopyText): Promise<CompareResult | null | ReadFailed> {
    const params = { params: { path: { formKey } } };
    return this.read(`getComparison(${formKey})`, (signal) => (text
      ? this.apiClient.POST('/records/{formKey}/compare', { ...params, body: text, signal })
      : this.apiClient.GET('/records/{formKey}/compare', { ...params, signal })),
    noBodyFails, { absent: { status: 404, answers: null } });
  }

  getRecordsComparison(copies: RecordCopy[]): Promise<CompareRecordsResponse | ReadFailed> {
    return this.read('getRecordsComparison', (signal) => this.apiClient.POST('/records/compare', { body: { copies }, signal }), noBodyFails);
  }

  getReferences(formKey: string): Promise<ReferenceResult[] | ReadFailed> {
    return this.read(`getReferences(${formKey})`, (signal) => this.apiClient.GET('/records/{formKey}/references', { params: { path: { formKey } }, signal }),
      (data) => data ?? []);
  }

  getReferencesInActiveOrTrackedPlugins(formKey: string): Promise<ReferenceResult[] | ReadFailed> {
    return this.read(`getReferencesInActiveOrTrackedPlugins(${formKey})`,
      (signal) => this.apiClient.GET('/records/{formKey}/references-in-active-or-tracked-plugins', { params: { path: { formKey } }, signal }),
      (data) => data ?? []);
  }

  getRenderedDocument({ name: plugin, origin }: PluginAddress, formKey: string): Promise<RenderedDocument | null | ReadFailed> {
    return this.read(`getRenderedDocument(${plugin}, ${formKey})`, (signal) => this.apiClient.GET('/plugins/{plugin}/records/{formKey}/rendered-document', {
      params: { path: { plugin, formKey }, query: { origin } }, signal,
    }), noBodyFails, { timed: true, absent: { status: 404, answers: null } });
  }

  getCopyDocument({ name: plugin, origin }: PluginAddress, formKey: string): Promise<CopyDocument | null | ReadFailed> {
    return this.read(`getCopyDocument(${plugin}, ${formKey})`, (signal) => this.apiClient.GET('/plugins/{plugin}/records/{formKey}/document', {
      params: { path: { plugin, formKey }, query: { origin } }, signal,
    }), noBodyFails, { timed: true, absent: { status: 404, answers: null } });
  }

  getRecordOfFile(path: string): Promise<RecordAddress | null | ReadFailed> {
    return this.read(`getRecordOfFile(${path})`, (signal) => this.apiClient.GET('/plugin-source/record', { params: { query: { path } }, signal }),
      noBodyFails, { timed: true, absent: { status: 204, answers: null } });
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
      return failureReason(UNREACHABLE);
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
      return failureReason(UNREACHABLE);
    }
  }

  getActiveFilter(): Promise<RecordFilter | null | ReadFailed> {
    return this.read('getActiveFilter', (signal) => this.apiClient.GET('/load-order/filter', { signal }), (data) => {
      if (data?.sql == null) return null;
      return data.source == null ? { failed: 'unreadable', cause: 'mEdit answered a record filter with no source.' } : { sql: data.sql, source: data.source };
    });
  }

  getWorldspaces({ name: plugin, origin }: PluginAddress): Promise<WorldspaceSummary[] | ReadFailed> {
    return this.read(`getWorldspaces(${plugin})`, (signal) => this.apiClient.GET('/plugins/{plugin}/worldspaces', {
      params: { path: { plugin }, query: { origin } }, signal,
    }), (data) => data ?? [], { timed: true });
  }

  getWorldspaceBlocks({ name: plugin, origin }: PluginAddress, worldspaceFormKey: string): Promise<WorldspaceBlocks | ReadFailed> {
    return this.read(`getWorldspaceBlocks(${plugin}, ${worldspaceFormKey})`, (signal) => this.apiClient.GET('/plugins/{plugin}/worldspaces/{formKey}/blocks', {
      params: { path: { plugin, formKey: worldspaceFormKey }, query: { origin } }, signal,
    }), (data) => data ?? { topCells: [], blocks: [] }, { timed: true });
  }

  getCellChildRecords({ name: plugin, origin }: PluginAddress, cellFormKey: string): Promise<CellChildRecords | ReadFailed> {
    return this.read(`getCellChildRecords(${plugin}, ${cellFormKey})`, (signal) => this.apiClient.GET('/plugins/{plugin}/cells/{formKey}/children', {
      params: { path: { plugin, formKey: cellFormKey }, query: { origin } }, signal,
    }), (data) => data ?? { persistent: [], temporary: [] }, { timed: true });
  }

  getInteriorCells({ name: plugin, origin }: PluginAddress): Promise<InteriorCellBlock[] | ReadFailed> {
    return this.read(`getInteriorCells(${plugin})`, (signal) => this.apiClient.GET('/plugins/{plugin}/interior-cells', {
      params: { path: { plugin }, query: { origin } }, signal,
    }), (data) => data ?? [], { timed: true });
  }

  getContainerChildren({ name: plugin, origin }: PluginAddress, parentFormKey: string): Promise<ContainerChildSummary[] | ReadFailed> {
    return this.read(`getContainerChildren(${plugin}, ${parentFormKey})`, (signal) => this.apiClient.GET('/plugins/{plugin}/records/{formKey}/children', {
      params: { path: { plugin, formKey: parentFormKey }, query: { origin } }, signal,
    }), (data) => data ?? [], { timed: true });
  }
}

const NO_ANSWER: ReadFailed = { failed: 'no-answer' };
const UNREACHABLE: ReadFailed = { failed: 'unreachable' };

function noBodyFails<D>(data: D | undefined): D | ReadFailed {
  return data === undefined ? NO_ANSWER : data;
}

let latest: Pick<MEditClient, 'stop'> = { stop: () => Promise.resolve() };

export function createMEditClient(deps: HttpMEditClientDeps): MEditClient {
  const client = new HttpMEditClient(deps);
  latest = client;
  return client;
}

/** Stops the client `createMEditClient` last made, for `deactivate()`, which receives nothing
 *  `activate()` built. */
export const stopMEditClient = (): Promise<void> => latest.stop();

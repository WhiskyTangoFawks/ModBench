import { trackLateness, trackProgress } from './lateness';
import type { components } from '../wire/generated/api';
import type { RecordEditEnvelope } from '../wire/messages';
import { SILENT_LOG, type Log } from '../ports/log';
import {
  createApiClient, errorText, isSettled, isTerminalLoadOrderStatusFor, openNotificationStream,
  toLoadOrderStatus, type ApiClient, type LoadOrderStatus, type CompareResult, type CompareRecordsAnswer, type CopyText,
} from './apiClient';
import { createUnlimitedFetch } from './unlimitedFetch';
import { rowsOf } from './selectedRows';
import { bundledBackendPath, spawnPiped } from './bundledBackend';
import { backendLogLevelArgs, makeBackendLogForwarder, type BackendLogChannel } from './backendLog';
import { BackendLifecycle, type BackendLifecycleOptions } from './backendLifecycle';
import { SseNotificationSubscriber, type ListenerThrows } from './notificationStream';
import { createLoadOrderSender, type LoadOrderSender, type SweepEnd } from './loadOrderSender';
import { createUnsavedHandOver, type UnsavedHandOver } from './unsavedHandOver';
import { keepLoadOrderStatus, type LoadOrderStatusKeeper } from './loadOrderStatusKeeper';
import { heldResults, STALE, type HeldAnswer, type HeldResults } from './heldResults';


import { problemsDivision, filePathsDivision } from './recordDivisions';
import { keepRecordIndexChanges, type RecordIndexChanges } from './recordIndexChanges';
import type { Disposable } from './eventEmitter';
import {
  type ArchiveContents, type BackendStatus, type CellChildRecords, type BuildFacts, type BuildMod, type BuildOutcome,
  type Submodule, type SubmodulesCloned, type PluginFilesFlagged, type PluginFileToFlag,
  type ContainerChildSummary, type InteriorCellBlock, type LaunchOutcome, type LoadOrderOutcome,
  type LoadOrderSnapshot, type LoadOrderProgress, type MEditClient, type ReadCancellation, type RecordIndexChange, type RecordIndexProgress, type NotificationKind, type NotificationPayloads,
  type PluginDiagnosisReport, type PluginMetadata, type PluginRecordTypeCount, type PluginIndexedState, type PluginFilePaths, type PluginProblems, type RecordTypeChoice, type RenderedDocument, type CopyDocument, type DocumentName,
  type RebuildIndexOutcome, type CopyChangesOutcome, type CopyMode,
  type GridPosition, type RecordAt, type CreateChangesOutcome, type RecordEditChangesOutcome, type RecordPage, type DeleteChangesOutcome, type UnsavedDocument, type RenameSourceChangesOutcome, type RenameSourceAsked,
  type SourceChanges, type SourceMove, type RecordFilter, type ReferenceResult, type PlacedReferences, type NameQuery, type NamedObject, type PluginAddress, type PluginToRepair, type ModToVersionInGit, type VersionInGitOutcome, type VersionInGitProgress, type KindedOutcome, type DecompileOutcome, type DecompileAndRepairOutcome,
  type WorkingTreeStatesBeneath, type WorldspaceBlocks, type WorldspaceSummary, type WriteRefused, type RowsRead, isRefused,
} from './MEditClient';
import { errorMessage } from '../ports/errorMessage';
import { failureReason, isReadFailed, localFailure, type ReadFailed } from '../wire/readFailed';
import type { ArchivedCopy, FlaggedPluginFile, FlaggedPluginHashes } from '../wire/messages';
import type { ItemRefusal } from '../ports/selectionOutcome';

// 30s is an ordinary HTTP-client default. A slow call and a hung one look the same to the tree,
// so nothing tries to tell them apart.
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

interface PostSpec<T> {
  op: string;
  failMsg: string;
  post: () => Promise<{ data?: T; error?: unknown; response: { ok: boolean; status: number } }>;
  /** What a 2xx with no body answers. */
  noContent?: T;
  /** The call answers the changes a write makes, which Modbench makes itself; every other call writes files only mEdit can name. */
  answersChanges?: true;
}

interface HttpMEditClientDeps {
  /** The process this client is the front of. It spawns the bundled backend unless told otherwise. */
  backend?: Omit<BackendLifecycleOptions, 'onOutput' | 'serilogLevelArgs' | 'log'>;
  /** Where the spawned backend's output goes, and whose level it is spawned at. */
  backendLog: BackendLogChannel;
  /** Overrides the production fetch (undici, unlimited timeouts) — a test scripts the backend's
   *  HTTP responses through this. */
  fetch?: (input: Request) => Promise<Response>;
  log?: Log;
  listenerThrows: ListenerThrows;
  /** Called by each call that writes files its caller cannot name. */
  leaveWritesUnnamed: () => void;
  timeoutMs?: number;
  reconnectDelayMs?: number;
}

function itemRefusals<R>(refused: { item: R; message: string }[]): ItemRefusal<R>[] {
  return refused.map((r) => ({ item: r.item, reason: r.message }));
}

function kindedSelectionOutcome<L, R, K extends string>(
  answer: { applied: L[]; refused: { item: R; refusal: K; message: string }[] },
): KindedOutcome<L, R, K> {
  return { landed: answer.applied, refused: answer.refused.map((r) => ({ item: r.item, reason: r.message, refusal: r.refusal })) };
}

function appliedWithRefusals<A, R>(
  answer: { applied: A[]; refused: { item: R; message: string }[] },
): { applied: A[]; refused: ItemRefusal<R>[] } {
  return { applied: answer.applied, refused: itemRefusals(answer.refused) };
}

// The backend's typed discriminator, off the ProblemDetails extension rather than re-derived from the
// status: only it tells "not a compiled plugin" from "no folder", whose ways out differ.
function refusalNamed(error: unknown): string | undefined {
  const refusal = typeof error === 'object' && error !== null ? (error as { refusal?: unknown }).refusal : undefined;
  return typeof refusal === 'string' ? refusal : undefined;
}

function editRefused(
  error: { refusal?: unknown; detail?: string | null } | undefined,
): { applied: false; refusal: string; message: string } {
  return {
    applied: false,
    refusal: refusalNamed(error) ?? 'Unknown',
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

type RecordsAsked = components['schemas']['RecordsAsked'];

interface ReadOptions<A> {
  timed?: boolean;
  absent?: { status: number; answers: A };
  held?: boolean;
  token?: ReadCancellation;
}

class HttpMEditClient implements MEditClient {
  private api?: { port: number; client: ApiClient };
  private readonly fetchImpl: (input: Request) => Promise<Response>;
  private readonly log: Log;
  private readonly problemsHeld = heldResults(problemsDivision);
  private readonly filePathsHeld = heldResults(filePathsDivision);
  private readonly timeoutMs: number;
  private readonly lifecycle: BackendLifecycle;
  private readonly notifications: SseNotificationSubscriber;
  private readonly loadOrder: LoadOrderSender;
  private readonly loadOrderStatusKept: LoadOrderStatusKeeper;
  private readonly handOver: UnsavedHandOver;
  private readonly changes: RecordIndexChanges;
  private readonly leaveWritesUnnamed: () => void;
  private sweepsAwaited = 0;
  private mEditSequence = 0;
  private readonly lateness = trackLateness(() => this.recordIndexMayBeLate);
  private readonly progress = trackProgress(() => this.recordIndexProgress);

  constructor(deps: HttpMEditClientDeps) {
    this.leaveWritesUnnamed = deps.leaveWritesUnnamed;
    this.log = deps.log ?? SILENT_LOG;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    this.fetchImpl = deps.fetch ?? createUnlimitedFetch();
    this.notifications = new SseNotificationSubscriber({
      openStream: (signal) => openNotificationStream(this.apiClient, signal),
      log: deps.log,
      listenerThrows: deps.listenerThrows,
      reconnectDelayMs: deps.reconnectDelayMs,
    });
    this.lifecycle = new BackendLifecycle(backendOptions(deps));
    // The stream is open exactly while the backend is attached, so no module outside this one
    // starts or stops it.
    this.lifecycle.onStatusChanged((status) => {
      if (status === 'running') {
        this.notifications.start();
        void this.hearFromHere();
      } else this.notifications.stop();
    });
    this.notifications.onReconnected(() => { void this.hearFromHere(); });
    for (const kind of ['rows-changed', 'plugin-changed', 'record-index-changed'] as const) {
      this.notifications.onNotification(kind, () => { this.lateness.note(); });
    }
    this.loadOrderStatusKept = keepLoadOrderStatus({
      onNotification: (kind, listener) => this.notifications.onNotification(kind, listener),
      onStatusChanged: (listener) => this.lifecycle.onStatusChanged(listener),
      onReconnected: (listener) => this.notifications.onReconnected(listener),
    });
    this.loadOrderStatusKept.onStatus(() => { this.lateness.note(); this.progress.note(); });
    this.loadOrder = createLoadOrderSender({
      status: () => this.lifecycle.status,
      onStatusChanged: (listener) => this.lifecycle.onStatusChanged(listener),
      onReconnected: (listener) => this.notifications.onReconnected(listener),
      start: () => this.lifecycle.start(),
      stop: () => this.lifecycle.stop(),
      put: (snapshot, signal, answered) => this.putLoadOrder(snapshot, signal, answered),
      signalChange: (paths) => this.postSignalChange(paths),
    });
    this.changes = keepRecordIndexChanges({
      onNotification: (kind, listener) => this.notifications.onNotification(kind, listener),
      onStatusChanged: (listener) => this.lifecycle.onStatusChanged(listener),
      onReconnected: (listener) => this.notifications.onReconnected(listener),
    }, this.loadOrderStatusKept);
    this.handOver = createUnsavedHandOver({
      status: () => this.lifecycle.status,
      onStatusChanged: (listener) => this.lifecycle.onStatusChanged(listener),
      onReconnected: (listener) => this.notifications.onReconnected(listener),
      put: (documents) => this.putUnsavedDocuments(documents),
    });
    this.handOver.onSettled((failure) => { if (failure === undefined) void this.awaitSweep(); });
    this.loadOrder.onPendingChanged(this.lateness.note);
    this.handOver.onPendingChanged(this.lateness.note);
  }

  // The port is the lifecycle's to choose, so the generated client is built once it is known.
  private get startedApiClient(): ApiClient | undefined {
    const port = this.lifecycle.port;
    if (port === undefined) return undefined;
    if (this.api?.port !== port) this.api = { port, client: createApiClient(port, this.fetchImpl) };
    return this.api.client;
  }

  private get apiClient(): ApiClient {
    const client = this.startedApiClient;
    if (client === undefined) throw new Error('mEdit has not started');
    return client;
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  onPort(listener: (port: number) => void): () => void { return this.lifecycle.onPort(listener); }
  get status(): BackendStatus { return this.lifecycle.status; }
  onStatusChanged(listener: (status: BackendStatus) => void): () => void {
    return this.lifecycle.onStatusChanged(listener);
  }
  async start(): Promise<void> { await this.loadOrder.launch(); }
  onLaunch(listener: (launched: Promise<LaunchOutcome>) => void): () => void { return this.loadOrder.onLaunch(listener); }
  onExit(listener: () => void): () => void { return this.loadOrder.onExit(listener); }
  stop(): Promise<void> { return this.loadOrder.stop(); }

  onDidChange(listener: (change: RecordIndexChange) => void): Disposable { return this.changes.onDidChange(listener); }
  onDidChangeRecordIndexMayBeLate(listener: (late: boolean) => void): Disposable { return this.lateness.event(listener); }
  async refreshRecordIndexLateness(token?: ReadCancellation): Promise<void> {
    const current = await this.currentSequence(token);
    if (!isReadFailed(current)) this.mEditSequence = Math.max(this.mEditSequence, current);
    this.lateness.note();
  }

  private get behindMEdit(): boolean { return this.notifications.heardSequence < this.mEditSequence; }

  get recordIndexMayBeLate(): boolean {
    return this.loadOrder.pending() || this.handOver.pending() || this.sweepsAwaited > 0 || this.behindMEdit || this.recordIndexProgress !== undefined;
  }

  get recordIndexProgress(): RecordIndexProgress | undefined { return this.loadOrderStatusKept.progress(); }
  onDidChangeRecordIndexProgress(listener: (progress: RecordIndexProgress | undefined) => void): Disposable { return this.progress.event(listener); }

  get loadOrderStatus(): LoadOrderStatus | undefined { return this.loadOrderStatusKept.current(); }
  onLoadOrderStatus(listener: (status: LoadOrderStatus | undefined) => void): () => void {
    return this.loadOrderStatusKept.onStatus(listener);
  }

  sendLoadOrder(snapshot: LoadOrderSnapshot): Promise<LoadOrderOutcome> { return this.loadOrder.send(snapshot); }
  latestLoadOrder(): Promise<LoadOrderOutcome | undefined> { return this.loadOrder.latest(); }
  loadOrderApplied(): Promise<boolean> { return this.loadOrder.applied(); }
  loadOrdersHanded(): number { return this.loadOrder.handed(); }
  signalChange(paths: readonly string[]): Promise<void> { return this.loadOrder.signalChange(paths); }

  handUnsavedDocuments(documents: readonly UnsavedDocument[]): void { this.handOver.hand(documents); }
  onUnsavedHandOver(listener: (failure: ReadFailed | undefined) => void): () => void { return this.handOver.onSettled(listener); }

  private putUnsavedDocuments(documents: readonly UnsavedDocument[]): Promise<ReadFailed | undefined> {
    return this.read('putUnsavedDocuments', (api, signal) => api.PUT('/unsaved-documents', { body: { documents: [...documents] }, signal }), () => undefined, { held: false });
  }

  // ── notifications ────────────────────────────────────────────────────────

  onNotification<K extends NotificationKind>(kind: K, listener: (payload: NotificationPayloads[K]) => void): () => void {
    return this.notifications.onNotification(kind, listener);
  }

  // ── writes ───────────────────────────────────────────────────────────────

  // Every write verb below shares this shape: wait for the load order and unsaved documents it
  // depends on, then `sendNow`. No refresh, no toast — the caller does both, from what this returns.
  private async mutate<T>(spec: PostSpec<T>): Promise<T | WriteRefused> {
    if (spec.answersChanges !== true) this.leaveWritesUnnamed();
    try {
      await this.handOver.sent();
      await this.loadOrder.applied();
    } catch (e) {
      return this.refusedUnreachable(spec, e);
    }
    return this.sendNow(spec);
  }

  // POST, map a non-ok response or a thrown request onto WriteRefused, otherwise hand back the wire
  // data untouched. For a request that depends on neither the load order nor the unsaved documents.
  private async sendNow<T>(spec: PostSpec<T>): Promise<T | WriteRefused> {
    try {
      const { data, error, response } = await spec.post();
      if (!response.ok) {
        const text = errorText(error);
        this.log.error(`[HttpMEditClient] ${spec.op} failed (${response.status}): ${text}`);
        return { refused: true, message: `${spec.failMsg} — ${text}` };
      }
      return data ?? spec.noContent ?? { refused: true, message: `${spec.failMsg} — no answer` };
    } catch (e) {
      return this.refusedUnreachable(spec, e);
    }
  }

  private refusedUnreachable(spec: { op: string; failMsg: string }, e: unknown): WriteRefused {
    this.log.error(`[HttpMEditClient] ${spec.op} threw: ${errorMessage(e)}`);
    return { refused: true, message: `${spec.failMsg} — ${failureReason(UNREACHABLE)}`, unreachable: true };
  }

  // A write over a selection: each item lands or is refused on its own, and the counted phrase
  // ("3 plugins") names the selection in the log line and the refusal.
  private async mutateEach<T extends { refused: { item: unknown; message: string }[] }, O>(spec: {
    gesture: (counted: string) => string;
    noun: string;
    items: readonly unknown[];
    op: (counted: string) => string;
    post: () => Promise<{ data?: T; error?: unknown; response: { ok: boolean; status: number } }>;
    outcome: (answer: T) => O;
    answersChanges?: true;
  }): Promise<O | WriteRefused> {
    const counted = spec.items.length === 1 ? `1 ${spec.noun}` : `${spec.items.length} ${spec.noun}s`;
    const answer = await this.mutate({ op: spec.op(counted), failMsg: `Could not ${spec.gesture(counted)}`, post: spec.post, answersChanges: spec.answersChanges });
    return isRefused(answer) ? answer : spec.outcome(answer);
  }

  async createPlugin(
    plugin: PluginAddress, folder: string, sourceFolder: string | undefined, flags: readonly string[] | undefined,
  ): Promise<PluginAddress | WriteRefused> {
    const failMsg = `Could not create "${plugin.name}"`;
    const answer = await this.mutate({
      op: `createPlugin(${plugin.name}, ${plugin.origin})`,
      failMsg,
      post: () => this.apiClient.POST('/plugins/create', { body: { origin: plugin.origin, name: plugin.name, folder, sourceFolder, flags: flags === undefined ? undefined : [...flags] } }),
    });
    return answer;
  }

  async getRenameSourceChanges(
    plugin: PluginAddress, newName: string, { namedByFileName, sourceFiles }: RenameSourceAsked,
  ): Promise<RenameSourceChangesOutcome | WriteRefused> {
    return this.mutate<RenameSourceChangesOutcome>({
      op: `getRenameSourceChanges(${plugin.name}, ${plugin.origin})`,
      failMsg: `Could not rename "${plugin.name}"`,
      post: () => this.apiClient.POST('/plugins/rename-source-changes', {
        body: { origin: plugin.origin, name: plugin.name, newName, namedByFileName, sourceFiles },
      }),
      answersChanges: true,
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

  async getSourceFolderMoveChanges(sourceFolder: string, movedTo: string, files: readonly SourceMove[]): Promise<SourceChanges | WriteRefused> {
    return this.mutate<SourceChanges>({
      op: `getSourceFolderMoveChanges(${sourceFolder})`,
      failMsg: `Could not move "${sourceFolder}"`,
      post: () => this.apiClient.POST('/source-folders/move-changes', { body: { sourceFolder, movedTo, files: [...files] } }),
      answersChanges: true,
    });
  }

  async followSourceFolderMove(sourceFolder: string, movedTo: string): Promise<{ followed: true } | WriteRefused> {
    return this.mutate({
      op: `followSourceFolderMove(${sourceFolder})`,
      failMsg: `Could not follow the move of "${sourceFolder}" in git`,
      post: () => this.apiClient.POST('/source-folders/follow-move', { body: { sourceFolder, movedTo } }),
      noContent: { followed: true },
    });
  }

  /** Discards the record index and refills it against the load order mEdit holds (commands.md, Instance). A 423 is
   *  `heldElsewhere` (ADR-0010), never a rejection. The refill is a sweep, late until it settles. */
  async rebuildIndex(instanceRoot: string, gameRelease: string): Promise<RebuildIndexOutcome> {
    const refills = this.loadOrderStatus?.holdsNone === false;
    try {
      const { error, response } = await this.apiClient.POST('/index/rebuild', { body: { instanceRoot, gameRelease } });
      if (!response.ok) {
        const text = errorText(error);
        this.log.error(`[HttpMEditClient] rebuildIndex failed (${response.status}): ${text}`);
        if (response.status === 423) return { rebuilt: false, heldElsewhere: true };
        return { rebuilt: false, heldElsewhere: false, detail: text };
      }
      if (refills) void this.awaitSweep((status) => isSettled(status) && !status.holdsNone);
      return { rebuilt: true };
    } catch (e) {
      this.log.error(`[HttpMEditClient] rebuildIndex threw: ${errorMessage(e)}`);
      return { rebuilt: false, heldElsewhere: false, detail: failureReason(UNREACHABLE) };
    }
  }

  private async postSignalChange(paths: readonly string[]): Promise<SweepEnd> {
    try {
      const { error, response } = await this.apiClient.POST('/signal-change', { body: { paths: [...paths] } });
      if (response.ok) return { ended: this.awaitSweep() };
      this.log.error(`[HttpMEditClient] signalChange failed (${response.status}): ${errorText(error)}`);
    } catch (e) {
      this.log.error(`[HttpMEditClient] signalChange threw: ${errorMessage(e)}`);
    }
    return { ended: Promise.resolve() };
  }

  // `instanceRoot` scopes the backend's index (ADR-0010). The signal aborts the PUT itself rather
  // than leaving it to notice a dead socket.
  private async putLoadOrder(snapshot: LoadOrderSnapshot, signal: AbortSignal, answered: () => void): Promise<LoadOrderOutcome> {
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
        body: snapshot,
        signal,
      });
    } catch (e) {
      unsubscribe();
      if (this.wasDeliberatelyAborted(signal)) return { outcome: 'abandoned' };
      throw e;
    }

    const { error, response, data } = result;
    answered();
    if (!response.ok || !data) {
      unsubscribe();
      const text = errorText(error);
      this.log.error(`[HttpMEditClient] putLoadOrder failed (${response.status}): ${text}`);
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

  // An answered hand-over or signal starts a sweep mEdit publishes as validating: late until a status holds no load order or settles, or is lost.
  private awaitSweep(over: (status: LoadOrderStatus) => boolean = (status) => status.holdsNone || isSettled(status)): Promise<void> {
    this.sweepsAwaited++;
    this.lateness.note();
    let finish!: () => void;
    const ended = new Promise<void>((resolve) => { finish = resolve; });
    const end = (): void => {
      if (subscription === undefined) return;
      subscription();
      subscription = undefined;
      this.sweepsAwaited--;
      finish();
      this.lateness.note();
    };
    let subscription: (() => void) | undefined = this.loadOrderStatusKept.onStatus((status) => { if (status === undefined || over(status)) end(); });
    void this.currentLoadOrderStatus().then((current) => { if (current !== undefined && over(current)) end(); });
    return ended;
  }

  // A process opened onto is heard from where it stands: everything before is said by the change that follows its opening.
  private async hearFromHere(): Promise<void> {
    this.notifications.forgetHeard();
    this.mEditSequence = 0;
    const current = await this.currentSequence();
    if (!isReadFailed(current)) this.notifications.hearUpTo(current);
  }

  private currentSequence(token?: ReadCancellation): Promise<number | ReadFailed> {
    return this.read('GET /load-order/sequence', (api, signal) => api.GET('/load-order/sequence', { signal }), noBodyFails, { token, held: false });
  }

  // Undefined when the read fails: the caller then waits on the stream's own ticks.
  private async currentLoadOrderStatus(): Promise<LoadOrderStatus | undefined> {
    try {
      const { data } = await this.apiClient.GET('/load-order/status', {});
      return data ? toLoadOrderStatus(data) : undefined;
    } catch (e) {
      this.log.error(`[HttpMEditClient] reading the load order status threw: ${errorMessage(e)}`);
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
    this.log.info('[HttpMEditClient] putLoadOrder was aborted — mEdit was closed while it reconciled');
    return true;
  }

  /** ADR-0007; commands.md, A selection is one gesture, and each item lands on its own. */
  async versionInGit(
    mods: readonly ModToVersionInGit[], options: { onProgress?: (status: VersionInGitProgress) => void } = {},
  ): Promise<VersionInGitOutcome | WriteRefused> {
    // The POST stays blocking, so progress rides the version-in-git-progress notification alongside it.
    const unsubscribe = options.onProgress ? this.notifications.onNotification('version-in-git-progress', options.onProgress) : () => {};
    try {
      return await this.mutateEach({
        gesture: (counted) => `put ${counted} under git`, noun: 'mod', items: mods.map((mod) => mod.name),
        op: (counted) => `versionInGit(${counted})`,
        post: () => this.apiClient.POST('/version-in-git', { body: { mods: [...mods] } }),
        outcome: kindedSelectionOutcome,
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
      answersChanges: true,
    });
  }

  async getDeleteChanges(
    records: readonly RecordAt[],
  ): Promise<DeleteChangesOutcome | WriteRefused> {
    return this.mutateEach({
      gesture: (counted) => `delete ${counted}`, noun: 'record', items: records,
      op: (counted) => `getDeleteChanges(${counted})`,
      post: () => this.apiClient.POST('/records/delete-changes', { body: { records: [...records] } }),
      outcome: appliedWithRefusals,
      answersChanges: true,
    });
  }

  async getCopyChanges(
    records: readonly RecordAt[], mode: CopyMode, destinations: readonly PluginAddress[], replace: boolean,
  ): Promise<CopyChangesOutcome | WriteRefused> {
    return this.mutateEach({
      gesture: (counted) => `copy ${counted}`, noun: 'record', items: records,
      op: (counted) => `getCopyChanges(${counted}, ${mode})`,
      post: () => this.apiClient.POST('/records/copy-changes', {
        body: { records: [...records], mode, destinations: [...destinations], replace },
      }),
      outcome: appliedWithRefusals,
      answersChanges: true,
    });
  }

  async decompile(plugins: readonly PluginAddress[], force: boolean): Promise<DecompileOutcome | WriteRefused> {
    return this.mutateEach({
      gesture: (counted) => `decompile ${counted}`, noun: 'plugin', items: plugins,
      op: (counted) => `decompile(${counted})`,
      post: () => this.apiClient.POST('/plugins/decompile', { body: { plugins: [...plugins], force } }),
      outcome: kindedSelectionOutcome,
    });
  }

  async decompileAndRepair(
    plugins: readonly PluginToRepair[], force: boolean,
  ): Promise<DecompileAndRepairOutcome | WriteRefused> {
    return this.mutateEach({
      gesture: (counted) => `decompile and repair ${counted}`, noun: 'plugin', items: plugins,
      op: (counted) => `decompileAndRepair(${counted})`,
      post: () => this.apiClient.POST('/plugins/decompile-and-repair', { body: { plugins: [...plugins], force } }),
      outcome: kindedSelectionOutcome,
    });
  }

  /** Each mod builds or is refused on its own, and each plugin of a built mod compiles or is
   *  refused on its own. Never refreshes the tree: a build changes only bytes on disk. */
  async build(mods: readonly BuildMod[], facts: BuildFacts): Promise<BuildOutcome | WriteRefused> {
    return this.mutateEach({
      gesture: (counted) => `build ${counted}`, noun: 'mod', items: mods,
      op: (counted) => `build(${counted})`,
      post: () => this.apiClient.POST('/build', { body: { mods: [...mods], ...facts } }),
      outcome: (answer) => ({
        landed: answer.applied.map((m) => ({
          mod: m.mod, compiled: m.compiled,
          refused: m.refused.map(({ item, refusal, message }) => ({ item, refusal, reason: message })), archivesRefused: itemRefusals(m.archivesRefused),
          made: m.made,
          ...(m.packed.length > 0 ? { packed: m.packed } : {}),
          ...(m.replaced.length > 0 ? { replaced: m.replaced } : {}),
          ...(m.ignored.length > 0 ? { ignored: m.ignored } : {}),
          ...(m.failure ? { failure: m.failure } : {}),
          ...(m.uncommitted ? { uncommitted: true as const } : {}),
          ...(m.unpushed ? { unpushed: true as const } : {}),
        })),
        refused: itemRefusals(answer.refused),
      }),
    });
  }

  cloneSubmodules(submodules: readonly Submodule[]): Promise<SubmodulesCloned | WriteRefused> {
    return this.mutate({
      op: `cloneSubmodules(${submodules.length})`,
      failMsg: 'Could not clone the submodules the instance repository pins',
      post: () => this.apiClient.POST('/clone-submodules', { body: { submodules: [...submodules] } }),
    });
  }

  setPluginFileFlags(gameRelease: string, files: readonly PluginFileToFlag[]): Promise<PluginFilesFlagged | WriteRefused> {
    return this.mutate({
      op: `setPluginFileFlags(${files.length})`,
      failMsg: 'Could not set the load flags of the plugin files',
      post: () => this.apiClient.POST('/plugin-files/set-flags', { body: { gameRelease, files: [...files] } }),
    });
  }

  /** A refusal (non-compiled plugin, a link that would dangle) comes back typed (ADR-0014), and so does a
   *  transport failure, as the unknown refusal. */
  async getEditChanges(
    formKey: string, { name: plugin, origin }: PluginAddress, envelope: RecordEditEnvelope,
  ): Promise<RecordEditChangesOutcome> {
    await this.handOver.sent();
    await this.loadOrder.applied();
    let result;
    try {
      result = await this.apiClient.POST('/records/{formKey}/edit-changes', {
        params: { path: { formKey } },
        body: { edit: { plugin, origin, ...envelope } },
      });
    } catch (e) {
      this.log.error(`[HttpMEditClient] getEditChanges(${formKey}) threw: ${errorMessage(e)}`);
      return { applied: false, refusal: 'Unknown', message: failureReason(UNREACHABLE) };
    }
    const { data, error, response } = result;
    if (response.ok && data) {
      const { moves, deletions, documents, newFormKey, plugins, leftBehind, copiesLeftBehind, copiesUnread } = data;
      const changes = { applied: true as const, moves, deletions, documents, plugins, leftBehind, copiesLeftBehind, copiesUnread };
      return newFormKey ? { ...changes, newFormKey } : changes;
    }

    const outcome = editRefused(error);
    this.log.warn(`[HttpMEditClient] getEditChanges(${formKey} ${envelope.op} ${JSON.stringify(envelope.path)}) refused: ${outcome.refusal} — ${outcome.message}`);
    return outcome;
  }

  // ── reads ────────────────────────────────────────────────────────────────

  // A read that does not land answers a ReadFailed, never an empty list (common.md, States, story 2).
  // This is the one log line per failed read, with the transport's detail (ADR-0019); views do not repeat it.
  private async read<D, A>(
    what: string,
    call: (api: ApiClient, signal: AbortSignal) => Promise<{ data?: D; error?: unknown; response: Response }>,
    answer: (data: D | undefined) => A | ReadFailed | Promise<A | ReadFailed>,
    { token, ...options }: ReadOptions<A> = {},
  ): Promise<A | ReadFailed> {
    if (token?.isCancellationRequested) return CANCELLED;
    const controller = new AbortController();
    let subscription: Disposable | undefined;
    const cancelled = new Promise<ReadFailed>((resolve) => {
      subscription = token?.onCancellationRequested(() => { controller.abort(); resolve(CANCELLED); });
    });
    try {
      return await Promise.race([this.readHeld(what, call, answer, options, controller), cancelled]);
    } finally {
      subscription?.dispose();
    }
  }

  private async readHeld<D, A>(
    what: string,
    call: (api: ApiClient, signal: AbortSignal) => Promise<{ data?: D; error?: unknown; response: Response }>,
    answer: (data: D | undefined) => A | ReadFailed | Promise<A | ReadFailed>,
    { timed = false, absent, held = true }: Omit<ReadOptions<A>, 'token'>,
    controller: AbortController,
  ): Promise<A | ReadFailed> {
    if (held) {
      await this.handOver.sent();
      await this.loadOrder.applied();
    }
    if (controller.signal.aborted) return CANCELLED;
    const api = this.startedApiClient;
    if (api === undefined) {
      this.log.error(`[HttpMEditClient] ${what}: mEdit has not started`);
      return UNREACHABLE;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = call(api, controller.signal).then(({ data, error, response }): A | ReadFailed | Promise<A | ReadFailed> => {
      if (absent && response.status === absent.status) return absent.answers;
      if (!response.ok) {
        const text = errorText(error);
        this.log.error(`[HttpMEditClient] ${what} failed (${response.status})${text ? `: ${text}` : ''}`);
        return text ? { failed: refusalNamed(error) === 'NoLoadOrder' ? 'no-load-order' : 'refused', refusal: text } : NO_ANSWER;
      }
      const answered = answer(data);
      if (!(answered instanceof Promise) && isReadFailed(answered)) this.log.error(`[HttpMEditClient] ${what}: mEdit answered with no body`);
      return answered;
    }, (e: unknown): ReadFailed => {
      if (controller.signal.aborted) return CANCELLED;
      this.log.error(`[HttpMEditClient] ${what} threw: ${errorMessage(e)}`);
      return UNREACHABLE;
    });
    if (!timed) return settled;
    // Races rather than trusting the fetch to honor the signal: a hung backend and an
    // uncooperative test double both still settle. The signal is aborted anyway, so a fetch that
    // honors it cancels for real.
    const deadline = new Promise<ReadFailed>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        this.log.error(`[HttpMEditClient] ${what} timed out after ${this.timeoutMs}ms`);
        resolve({ failed: 'timed-out' });
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([settled, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  getPlugins(plugins?: readonly PluginAddress[], token?: ReadCancellation): Promise<PluginMetadata[] | ReadFailed> {
    if (plugins) {
      return this.read('POST /plugins/facts', (api, signal) => api.POST('/plugins/facts', { body: { plugins: [...plugins] }, signal }), (data) => data ?? [], { token });
    }
    return this.read('GET /plugins', (api, signal) => api.GET('/plugins', { signal }), (data) => data ?? [], { token });
  }

  getDiagnoses(token?: ReadCancellation): Promise<PluginDiagnosisReport[] | ReadFailed> {
    return this.read('GET /plugins/diagnoses', (api, signal) => api.GET('/plugins/diagnoses', { signal }), (data) => data ?? [], { token });
  }

  getPluginIndexing({ name: plugin, origin }: PluginAddress, token?: ReadCancellation): Promise<PluginIndexedState | ReadFailed> {
    return this.read(`getPluginIndexing(${plugin})`, (api, signal) => api.GET('/plugins/{plugin}/indexed-as-on-disk', {
      params: { path: { plugin }, query: { origin } }, signal,
    }), noBodyFails, { token });
  }

  getPluginProblems(plugin?: PluginAddress, token?: ReadCancellation, keys?: readonly string[]): Promise<PluginProblems[] | ReadFailed> {
    return this.askedByRecord('getPluginProblems', this.problemsHeld, plugin, keys, token, (api, signal, address, body) =>
      api.POST('/plugins/problems', { params: { query: address === undefined ? {} : { plugin: address.name, origin: address.origin } }, body, signal }));
  }

  getPluginFilePaths(plugin?: PluginAddress, token?: ReadCancellation, keys?: readonly string[]): Promise<PluginFilePaths[] | ReadFailed> {
    return this.askedByRecord('getPluginFilePaths', this.filePathsHeld, plugin, keys, token, (api, signal, address, body) =>
      api.POST('/plugins/file-paths', { params: { query: address === undefined ? {} : { plugin: address.name, origin: address.origin } }, body, signal }));
  }

  private async askedByRecord<A extends HeldAnswer, Part>(
    what: string, held: HeldResults<A, Part>, plugin: PluginAddress | undefined, keys: readonly string[] | undefined, token: ReadCancellation | undefined,
    post: (api: ApiClient, signal: AbortSignal, address: PluginAddress | undefined, body: RecordsAsked) => Promise<{ data?: A[]; error?: unknown; response: Response }>,
  ): Promise<A[] | ReadFailed> {
    const ask = async (named: readonly string[] | undefined, withKnown: boolean) => {
      const known = withKnown ? held.known(plugin) : [];
      const answer = await this.read(what, (api, signal) => post(api, signal, plugin, { keys: named ? [...named] : null, known }),
        noBodyFails, { token, timed: true });
      return { answer, known, keyed: named !== undefined };
    };
    let asked = await ask(plugin && keys && held.holds(plugin) ? keys : undefined, true);
    if (!isReadFailed(asked.answer) && asked.keyed && asked.answer.some(({ failure }) => failure != null)) asked = await ask(undefined, true);
    if (isReadFailed(asked.answer)) return asked.answer;
    const first = held.merge(asked.answer, asked.known, plugin, asked.keyed);
    if (first !== STALE) return first;
    const whole = await ask(undefined, false);
    if (isReadFailed(whole.answer)) return whole.answer;
    const merged = held.merge(whole.answer, [], plugin, false);
    return merged === STALE ? whole.answer : merged;
  }

  getRecordTypes({ name: plugin, origin }: PluginAddress, token?: ReadCancellation): Promise<PluginRecordTypeCount[] | ReadFailed> {
    return this.read(`getRecordTypes(${plugin})`, (api, signal) => api.GET('/plugins/{plugin}/record-types', {
      params: { path: { plugin }, query: { origin } }, signal,
    }), (data) => data ?? [], { token, timed: true });
  }

  getWorkingTreeStatesBeneath({ name: plugin, origin }: PluginAddress, token?: ReadCancellation): Promise<WorkingTreeStatesBeneath | ReadFailed> {
    return this.read(`getWorkingTreeStatesBeneath(${plugin})`, (api, signal) => api.GET('/plugins/{plugin}/working-tree-states-beneath', {
      params: { path: { plugin }, query: { origin } }, signal,
    }), noBodyFails, { token, timed: true });
  }

  getCreatableRecordTypes(token?: ReadCancellation): Promise<RecordTypeChoice[] | ReadFailed> {
    return this.read('getCreatableRecordTypes', (api, signal) => api.GET('/record-types/creatable', { signal }), (data) => data ?? [], { token, timed: true });
  }

  getChildRecordTypes({ name: plugin, origin }: PluginAddress, formKey: string, token?: ReadCancellation): Promise<RecordTypeChoice[] | ReadFailed> {
    return this.read(`getChildRecordTypes(${plugin}, ${formKey})`, (api, signal) => api.GET('/plugins/{plugin}/records/{formKey}/child-record-types', {
      params: { path: { plugin, formKey }, query: { origin } }, signal,
    }), (data) => data ?? [], { token, timed: true });
  }

  getCreatablePluginExtensions(token?: ReadCancellation): Promise<string[] | ReadFailed> {
    return this.read('getCreatablePluginExtensions', (api, signal) => api.GET('/plugins/creatable-extensions', { signal }), (data) => data ?? [], { token, timed: true });
  }

  getCreatablePluginFlags(name: string, token?: ReadCancellation): Promise<string[][] | ReadFailed> {
    return this.read('getCreatablePluginFlags', (api, signal) => api.GET('/plugins/creatable-flags', { params: { query: { name } }, signal }), (data) => data ?? [], { token, timed: true });
  }

  getArchiveContents(gameRelease: string, archives: readonly string[], token?: ReadCancellation): Promise<ArchiveContents[] | ReadFailed> {
    return this.read(`getArchiveContents(${archives.length} archives)`, (api, signal) => api.POST('/archives/contents', {
      body: { gameRelease, archives: [...archives] }, signal,
    }), noBodyFails, { token, timed: true });
  }

  getArchiveFile(gameRelease: string, archive: string, file: string, token?: ReadCancellation): Promise<Uint8Array | ReadFailed> {
    return this.read(`getArchiveFile(${archive}, ${file})`, async (api, signal) => {
      const { data, error, response } = await api.POST('/archives/file', { body: { gameRelease, archive, file }, parseAs: 'arrayBuffer', signal });
      return { data: data === undefined ? undefined : new Uint8Array(data), error, response };
    }, noBodyFails, { token, timed: true });
  }

  getArchiveCopies(gameRelease: string, archive: string, files: readonly string[], hashed: boolean, token?: ReadCancellation): Promise<ArchivedCopy[] | ReadFailed> {
    return this.read(`getArchiveCopies(${archive}, ${files.length} files)`, (api, signal) => api.POST('/archives/copies', {
      body: { gameRelease, archive, files: [...files], hashed }, signal,
    }), noBodyFails, { token, timed: true });
  }

  getFlaggedPluginHashes(gameRelease: string, files: readonly FlaggedPluginFile[], token?: ReadCancellation): Promise<FlaggedPluginHashes[] | ReadFailed> {
    return this.read(`getFlaggedPluginHashes(${files.length})`, (api, signal) => api.POST('/plugin-files/flagged-hashes', {
      body: { gameRelease, files: [...files] }, signal,
    }), noBodyFails, { token, timed: true });
  }

  getRecords({ name: plugin, origin }: PluginAddress, type: string, offset: number, limit: number, token?: ReadCancellation): Promise<RecordPage | ReadFailed> {
    return this.read(`getRecords(${plugin}, ${type})`, (api, signal) => api.GET('/records', {
      params: { query: { plugin, type: [type], offset, limit, origin } }, signal,
    }), (data) => data ?? { items: [], total: 0 }, { token, timed: true });
  }

  searchRecords(query: string, validTypes: string[], plugin?: PluginAddress, atMost = 20, token?: ReadCancellation): Promise<RecordPage | ReadFailed> {
    return this.read(`searchRecords(${query})`, (api, signal) => api.GET('/records', {
      params: { query: {
        search: query, ...(validTypes.length > 0 ? { type: validTypes } : {}), limit: atMost,
        ...(plugin && { plugin: plugin.name, origin: plugin.origin }),
      } },
      signal,
    }), (data) => data ?? { items: [], total: 0 }, { token });
  }

  getRecordOwners(formKey: string, token?: ReadCancellation): Promise<PluginAddress[] | ReadFailed> {
    return this.read(`getRecordOwners(${formKey})`, (api, signal) => api.GET('/records/{formKey}/owners', { params: { path: { formKey } }, signal }),
      noBodyFails, { token });
  }

  // A 404 (unknown FormKey) is "nothing holds it yet", not a fault.
  getRecordHolders(formKey: string, token?: ReadCancellation): Promise<PluginAddress[] | ReadFailed> {
    return this.read(`getRecordHolders(${formKey})`, (api, signal) => api.GET('/records/{formKey}/compare', { params: { path: { formKey } }, signal }),
      (data) => (data?.overrides ?? []).map((o) => ({ name: o.plugin, origin: o.origin })), { token, absent: { status: 404, answers: [] } });
  }

  resolveNames(names: readonly NameQuery[], token?: ReadCancellation): Promise<NamedObject[] | ReadFailed> {
    return this.read('resolveNames', (api, signal) => api.POST('/names/resolve', { body: { names: [...names] }, signal }), noBodyFails, { token });
  }

  selectRows(sql: string, atMostChars: number, token?: ReadCancellation): Promise<RowsRead | ReadFailed> {
    return this.read('selectRows', (api, signal) => api.POST('/records/select', { body: { sql }, parseAs: 'stream', signal }),
      (body) => (body ? this.rowsRead(body, atMostChars, token) : NO_ANSWER), { token });
  }

  private async rowsRead(body: ReadableStream<Uint8Array>, atMostChars: number, token?: ReadCancellation): Promise<RowsRead | ReadFailed> {
    try {
      return await rowsOf(body, atMostChars, (reason) => { this.log.error(`[HttpMEditClient] selectRows stopped: ${reason}`); });
    } catch (e) {
      if (token?.isCancellationRequested) return CANCELLED;
      this.log.error(`[HttpMEditClient] selectRows threw: ${errorMessage(e)}`);
      return e instanceof SyntaxError ? { failed: 'unreadable' } : UNREACHABLE;
    }
  }

  getComparison(formKey: string, text?: CopyText, token?: ReadCancellation): Promise<CompareResult | null | ReadFailed> {
    const params = { params: { path: { formKey } } };
    return this.read(`getComparison(${formKey})`, (api, signal) => (text
      ? api.POST('/records/{formKey}/compare', { ...params, body: text, signal })
      : api.GET('/records/{formKey}/compare', { ...params, signal })),
    noBodyFails, { token, absent: { status: 404, answers: null } });
  }

  getRecordsComparison(copies: components['schemas']['RecordCopy'][], token?: ReadCancellation): Promise<CompareRecordsAnswer | ReadFailed> {
    return this.read('getRecordsComparison', (api, signal) => api.POST('/records/compare', { body: { copies }, signal }), noBodyFails, { token });
  }

  getReferencesInActiveOrCompiledPlugins(formKey: string, token?: ReadCancellation): Promise<ReferenceResult[] | ReadFailed> {
    return this.read(`getReferencesInActiveOrCompiledPlugins(${formKey})`,
      (api, signal) => api.GET('/records/{formKey}/references-in-active-or-compiled-plugins', { params: { path: { formKey } }, signal }),
      (data) => data ?? [], { token });
  }

  getPlacedReferences(formKey: string, token?: ReadCancellation): Promise<PlacedReferences | ReadFailed> {
    return this.read(`getPlacedReferences(${formKey})`,
      (api, signal) => api.GET('/records/{formKey}/placed-references', { params: { path: { formKey } }, signal }), noBodyFails, { token });
  }

  getPluginNameReferences(name: string, token?: ReadCancellation): Promise<components['schemas']['CopyNaming'][] | ReadFailed> {
    return this.read(`getPluginNameReferences(${name})`,
      (api, signal) => api.GET('/plugin-names/{name}/references', { params: { path: { name } }, signal }),
      (data) => data ?? [], { token });
  }

  getScriptReferences(name: string, token?: ReadCancellation): Promise<components['schemas']['MemberReferences'] | ReadFailed> {
    return this.read(`getScriptReferences(${name})`,
      (api, signal) => api.GET('/script-names/{name}/references', { params: { path: { name } }, signal }), noBodyFails, { token });
  }

  getFileReferences(path: string, token?: ReadCancellation): Promise<components['schemas']['MemberReferences'] | ReadFailed> {
    return this.read(`getFileReferences(${path})`,
      (api, signal) => api.GET('/file-paths/references', { params: { query: { path } }, signal }), noBodyFails, { token });
  }

  getScriptRenameSourceChanges(name: string, newName: string, token?: ReadCancellation): Promise<components['schemas']['ScriptRenameSourceChanges'] | ReadFailed> {
    return this.read(`getScriptRenameSourceChanges(${name}, ${newName})`,
      (api, signal) => api.POST('/script-names/rename-source-changes', { body: { name, newName }, signal }), noBodyFails, { token });
  }

  getPluginSourceNames(text: string, path?: string, at?: number, token?: ReadCancellation): Promise<DocumentName[] | ReadFailed> {
    return this.read(`getPluginSourceNames(${path ?? 'a document with no file'})`,
      (api, signal) => api.POST('/plugin-source/names', { body: { text, path, at }, signal }), (data) => data ?? [], { token });
  }

  getRenderedDocument({ name: plugin, origin }: PluginAddress, formKey: string, token?: ReadCancellation): Promise<RenderedDocument | null | ReadFailed> {
    return this.read(`getRenderedDocument(${plugin}, ${formKey})`, (api, signal) => api.GET('/plugins/{plugin}/records/{formKey}/rendered-document', {
      params: { path: { plugin, formKey }, query: { origin } }, signal,
    }), noBodyFails, { token, timed: true, absent: { status: 404, answers: null } });
  }

  getCopyDocument({ name: plugin, origin }: PluginAddress, formKey: string, token?: ReadCancellation): Promise<CopyDocument | null | ReadFailed> {
    return this.read(`getCopyDocument(${plugin}, ${formKey})`, (api, signal) => api.GET('/plugins/{plugin}/records/{formKey}/document', {
      params: { path: { plugin, formKey }, query: { origin } }, signal,
    }), noBodyFails, { token, timed: true, absent: { status: 404, answers: null } });
  }

  getRecordOfFile(path: string, token?: ReadCancellation): Promise<RecordAt | null | ReadFailed> {
    return this.read(`getRecordOfFile(${path})`, (api, signal) => api.GET('/plugin-source/record', { params: { query: { path } }, signal }),
      noBodyFails, { token, timed: true, absent: { status: 204, answers: null } });
  }

  async setFilter(filter: RecordFilter): Promise<string | null> {
    try {
      const { error, response } = await this.apiClient.POST('/load-order/filter', { body: filter });
      if (!response.ok) {
        const text = errorText(error);
        this.log.error(`[HttpMEditClient] setFilter failed (${response.status}): ${text}`);
        return text;
      }
      return null;
    } catch (e) {
      this.log.error(`[HttpMEditClient] setFilter failed: ${errorMessage(e)}`);
      return failureReason(UNREACHABLE);
    }
  }

  async clearFilter(): Promise<string | null> {
    try {
      const { error, response } = await this.apiClient.DELETE('/load-order/filter', {});
      if (!response.ok) {
        const text = errorText(error);
        this.log.error(`[HttpMEditClient] clearFilter failed (${response.status}): ${text}`);
        return text;
      }
      return null;
    } catch (e) {
      this.log.error(`[HttpMEditClient] clearFilter failed: ${errorMessage(e)}`);
      return failureReason(UNREACHABLE);
    }
  }

  getActiveFilter(token?: ReadCancellation): Promise<RecordFilter | null | ReadFailed> {
    return this.read('getActiveFilter', (api, signal) => api.GET('/load-order/filter', { signal }), noBodyFails,
      { token, absent: { status: 204, answers: null } });
  }

  getWorldspaces({ name: plugin, origin }: PluginAddress, token?: ReadCancellation): Promise<WorldspaceSummary[] | ReadFailed> {
    return this.read(`getWorldspaces(${plugin})`, (api, signal) => api.GET('/plugins/{plugin}/worldspaces', {
      params: { path: { plugin }, query: { origin } }, signal,
    }), (data) => data ?? [], { token, timed: true });
  }

  getWorldspaceBlocks({ name: plugin, origin }: PluginAddress, worldspaceFormKey: string, token?: ReadCancellation): Promise<WorldspaceBlocks | ReadFailed> {
    return this.read(`getWorldspaceBlocks(${plugin}, ${worldspaceFormKey})`, (api, signal) => api.GET('/plugins/{plugin}/worldspaces/{formKey}/blocks', {
      params: { path: { plugin, formKey: worldspaceFormKey }, query: { origin } }, signal,
    }), (data) => data ?? { topCells: [], blocks: [] }, { token, timed: true });
  }

  getCellChildRecords({ name: plugin, origin }: PluginAddress, cellFormKey: string, token?: ReadCancellation): Promise<CellChildRecords | ReadFailed> {
    return this.read(`getCellChildRecords(${plugin}, ${cellFormKey})`, (api, signal) => api.GET('/plugins/{plugin}/cells/{formKey}/children', {
      params: { path: { plugin, formKey: cellFormKey }, query: { origin } }, signal,
    }), (data) => data ?? { persistent: [], temporary: [] }, { token, timed: true });
  }

  getInteriorCells({ name: plugin, origin }: PluginAddress, token?: ReadCancellation): Promise<InteriorCellBlock[] | ReadFailed> {
    return this.read(`getInteriorCells(${plugin})`, (api, signal) => api.GET('/plugins/{plugin}/interior-cells', {
      params: { path: { plugin }, query: { origin } }, signal,
    }), (data) => data ?? [], { token, timed: true });
  }

  getContainerChildren({ name: plugin, origin }: PluginAddress, parentFormKey: string, token?: ReadCancellation): Promise<ContainerChildSummary[] | ReadFailed> {
    return this.read(`getContainerChildren(${plugin}, ${parentFormKey})`, (api, signal) => api.GET('/plugins/{plugin}/records/{formKey}/children', {
      params: { path: { plugin, formKey: parentFormKey }, query: { origin } }, signal,
    }), (data) => data ?? [], { token, timed: true });
  }
}

const CANCELLED = localFailure('The read was cancelled.');
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

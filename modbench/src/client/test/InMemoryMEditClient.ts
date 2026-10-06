import type { MEditClient, NotificationKind, NotificationPayloads, BackendStatus } from '../MEditClient';
import type { NotificationEvent } from '../apiClient';
import { NotificationListenerRegistry } from '../notificationStream';

// Every query and command a test can script; `putLoadOrder` counts as a command here — the
// distinction is architectural, not behavioural.
type QueryMethod =
  | 'getPlugins' | 'getDiagnoses' | 'getPluginDependants' | 'getPluginProblems' | 'getRecordTypes' | 'getCreatableRecordTypes' | 'getChildRecordTypes' | 'getCreatablePluginExtensions'
  | 'getRecords' | 'searchRecords'
  | 'getRecordOwner' | 'getRecordHolders' | 'getRecordsWithChildren' | 'getChildrenInDestinations' | 'getComparison' | 'getRecordsComparison' | 'getReferences'
  | 'getRenderedDocument' | 'getRecordFile' | 'getRecordOfFile'
  | 'getEditChanges'
  | 'getWorldspaces' | 'getWorldspaceBlocks' | 'getCellChildRecords' | 'getInteriorCells'
  | 'getContainerChildren' | 'setFilter' | 'clearFilter' | 'getActiveFilter';

type CommandMethod =
  | 'createPlugin' | 'renameSource' | 'rebuildIndex' | 'track' | 'createRecord' | 'deleteRecords'
  | 'copyRecords' | 'decompile' | 'compile' | 'editRecord' | 'putLoadOrder';

// Homomorphic over `MEditClient`'s own keys, so indexing either by a generic `K` below — read or
// write — stays exactly `Answer<K>`/`Handlers[K]` for the checker, never a wider or narrower type.
type Answers = { [K in QueryMethod | CommandMethod]: Awaited<ReturnType<Extract<MEditClient[K], (...a: never[]) => unknown>>> };
type Answer<K extends QueryMethod | CommandMethod> = Answers[K];
type Handlers = {
  [K in CommandMethod]: (
    ...args: Parameters<Extract<MEditClient[K], (...a: never[]) => unknown>>
  ) => Promise<Answer<K>>;
};

export interface RecordedCall {
  method: string;
  args: unknown[];
}

// One scripted step, queued per method: resolves an answer or rejects with an error. An answer
// may be a pending `PromiseLike`, held in flight on a test's own schedule.
type ScriptedStep<T> = { kind: 'answer'; value: T | PromiseLike<T> } | { kind: 'failure'; error: Error };

// Homomorphic over `QueryMethod`, for the same reason `Answers` is: `QueryQueues[K]` (not
// `ScriptedStep<Answer<K>>[]` inline) is what keeps a generic-keyed write sound.
type QueryQueues = { [K in QueryMethod]: ScriptedStep<Answer<K>>[] };

// The fixed (non-queued) answer/result, boxed: a void answer is a real scripted value, and
// only the box's own presence can tell that apart from nothing having been scripted.
type Scripted<T> = { value: T };
type ScriptedAnswers = { [K in QueryMethod]: Scripted<Answer<K>>[] };
type ScriptedResults = { [K in CommandMethod]: Scripted<Answer<K>>[] };

/** The in-memory adapter (target-architecture.d2, mEdit client): a test scripts each answer by
 *  method name, drives notifications with `emit`, and reads every recorded call back. An
 *  unscripted query rejects, so a forgotten script fails loudly, not silently empty. */
export class InMemoryMEditClient implements MEditClient {
  readonly calls: RecordedCall[] = [];

  // Not readonly: `disconnected()` clears both wholesale by reassignment — the one mutation the
  // rest of this class does through `set`/`get`-shaped access instead.
  private queryAnswers: { [K in QueryMethod]?: ScriptedAnswers[K] } = {};
  private readonly queryFailures = new Map<QueryMethod, Error>();
  private queryQueues: { [K in QueryMethod]?: QueryQueues[K] } = {};
  private readonly commandResults: { [K in CommandMethod]?: ScriptedResults[K] } = {};
  private readonly commandFailures = new Map<CommandMethod, Error>();
  private readonly commandHandlers: { [K in CommandMethod]?: Handlers[K] } = {};
  private readonly notifications = new NotificationListenerRegistry();
  private readonly statusListeners = new Set<(status: BackendStatus) => void>();
  private readonly reconnectListeners = new Set<() => void>();
  private _status: BackendStatus = 'starting';

  setQueryAnswer<K extends QueryMethod>(method: K, answer: Answer<K>): void {
    const boxed: ScriptedAnswers[K] = [];
    boxed.push({ value: answer });
    this.queryAnswers[method] = boxed;
  }

  /** Every call to `method` rejects with `error` until re-scripted — the failure-shaped sibling
   *  of {@link setQueryAnswer}. */
  setQueryFailure(method: QueryMethod, error: Error): void {
    this.queryFailures.set(method, error);
  }

  /** Queues one answer, consumed by the next call to `method` and then discarded — for a test
   *  re-scripting a call sequence, or holding this one call in flight with a pending `answer`. */
  setQueryAnswerOnce<K extends QueryMethod>(method: K, answer: Answer<K> | PromiseLike<Answer<K>>): void {
    this.pushQueryStep(method, { kind: 'answer', value: answer });
  }

  /** {@link setQueryAnswerOnce}'s failure-shaped sibling — queues one rejection. */
  setQueryFailureOnce(method: QueryMethod, error: Error): void {
    this.pushQueryStep(method, { kind: 'failure', error });
  }

  private pushQueryStep<K extends QueryMethod>(method: K, step: ScriptedStep<Answer<K>>): void {
    const queue: QueryQueues[K] = this.queryQueues[method] ?? [];
    queue.push(step);
    this.queryQueues[method] = queue;
  }

  setCommandResult<K extends CommandMethod>(method: K, result: Answer<K>): void {
    const boxed: ScriptedResults[K] = [];
    boxed.push({ value: result });
    this.commandResults[method] = boxed;
  }

  /** Every call to `method` rejects with `error` until re-scripted — the failure-shaped sibling
   *  of {@link setCommandResult}. */
  setCommandFailure(method: CommandMethod, error: Error): void {
    this.commandFailures.set(method, error);
  }

  /** Answers `method` from the call's own arguments, taking precedence over the fixed result and
   *  failure above — for a test that holds a command in flight or answers differently per call. */
  setCommandHandler<K extends CommandMethod>(method: K, handler: Handlers[K]): void {
    this.commandHandlers[method] = handler;
  }

  get status(): BackendStatus { return this._status; }

  setStatus(status: BackendStatus): void {
    this._status = status;
    for (const listener of this.statusListeners) listener(status);
  }

  // One call: the backend goes disconnected and every query starts rejecting, same as a real
  // disconnected backend's read side.
  disconnected(): void {
    this.queryAnswers = {};
    this.queryFailures.clear();
    this.queryQueues = {};
    this.setStatus('disconnected');
  }

  onStatusChanged(listener: (status: BackendStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => { this.statusListeners.delete(listener); };
  }

  onReconnected(listener: () => void): () => void {
    this.reconnectListeners.add(listener);
    return () => { this.reconnectListeners.delete(listener); };
  }

  /** The notification stream dropped and opened again, the status never leaving `attached`. */
  reconnected(): void {
    for (const listener of [...this.reconnectListeners]) listener();
  }

  start(): Promise<void> { this.record('start', []); return Promise.resolve(); }
  stop(): Promise<void> { this.record('stop', []); return Promise.resolve(); }

  onNotification<K extends NotificationKind>(kind: K, listener: (payload: NotificationPayloads[K]) => void): () => void {
    this.record('onNotification', [kind]);
    return this.notifications.onNotification(kind, listener);
  }

  emit(event: NotificationEvent): void {
    this.notifications.dispatch(event);
  }

  private record(method: string, args: unknown[]): void {
    this.calls.push({ method, args });
  }

  private query<K extends QueryMethod>(method: K, args: unknown[]): Promise<Answer<K>> {
    this.record(method, args);
    const step = this.queryQueues[method]?.shift();
    if (step) return step.kind === 'answer' ? Promise.resolve(step.value) : Promise.reject(step.error);
    const failure = this.queryFailures.get(method);
    if (failure) return Promise.reject(failure);
    const scripted = this.queryAnswers[method]?.[0];
    if (!scripted) {
      return Promise.reject(new Error(`InMemoryMEditClient: no scripted answer for query "${method}"`));
    }
    return Promise.resolve(scripted.value);
  }

  private command<K extends CommandMethod>(
    method: K, args: Parameters<Extract<MEditClient[K], (...a: never[]) => unknown>>,
  ): Promise<Answer<K>> {
    this.record(method, args);
    const handler = this.commandHandlers[method];
    if (handler) return handler(...args);
    const failure = this.commandFailures.get(method);
    if (failure) return Promise.reject(failure);
    const scripted = this.commandResults[method]?.[0];
    if (!scripted) {
      return Promise.reject(new Error(`InMemoryMEditClient: no scripted result for command "${method}"`));
    }
    return Promise.resolve(scripted.value);
  }

  putLoadOrder(...args: Parameters<MEditClient['putLoadOrder']>): ReturnType<MEditClient['putLoadOrder']> {
    return this.command('putLoadOrder', args);
  }

  createPlugin(...args: Parameters<MEditClient['createPlugin']>): ReturnType<MEditClient['createPlugin']> {
    return this.command('createPlugin', args);
  }
  renameSource(...args: Parameters<MEditClient['renameSource']>): ReturnType<MEditClient['renameSource']> {
    return this.command('renameSource', args);
  }
  rebuildIndex(...args: Parameters<MEditClient['rebuildIndex']>): ReturnType<MEditClient['rebuildIndex']> {
    return this.command('rebuildIndex', args);
  }
  track(...args: Parameters<MEditClient['track']>): ReturnType<MEditClient['track']> {
    return this.command('track', args);
  }
  createRecord(...args: Parameters<MEditClient['createRecord']>): ReturnType<MEditClient['createRecord']> {
    return this.command('createRecord', args);
  }
  deleteRecords(...args: Parameters<MEditClient['deleteRecords']>): ReturnType<MEditClient['deleteRecords']> {
    return this.command('deleteRecords', args);
  }
  copyRecords(...args: Parameters<MEditClient['copyRecords']>): ReturnType<MEditClient['copyRecords']> {
    return this.command('copyRecords', args);
  }
  decompile(...args: Parameters<MEditClient['decompile']>): ReturnType<MEditClient['decompile']> {
    return this.command('decompile', args);
  }
  compile(...args: Parameters<MEditClient['compile']>): ReturnType<MEditClient['compile']> {
    return this.command('compile', args);
  }
  editRecord(...args: Parameters<MEditClient['editRecord']>): ReturnType<MEditClient['editRecord']> {
    return this.command('editRecord', args);
  }

  getPlugins(): ReturnType<MEditClient['getPlugins']> { return this.query('getPlugins', []); }
  getDiagnoses(): ReturnType<MEditClient['getDiagnoses']> { return this.query('getDiagnoses', []); }
  getPluginDependants(...args: Parameters<MEditClient['getPluginDependants']>): ReturnType<MEditClient['getPluginDependants']> {
    return this.query('getPluginDependants', args);
  }
  getPluginProblems(): ReturnType<MEditClient['getPluginProblems']> { return this.query('getPluginProblems', []); }
  getRecordTypes(...args: Parameters<MEditClient['getRecordTypes']>): ReturnType<MEditClient['getRecordTypes']> {
    return this.query('getRecordTypes', args);
  }

  getCreatableRecordTypes(): ReturnType<MEditClient['getCreatableRecordTypes']> {
    return this.query('getCreatableRecordTypes', []);
  }
  getChildRecordTypes(...args: Parameters<MEditClient['getChildRecordTypes']>): ReturnType<MEditClient['getChildRecordTypes']> {
    return this.query('getChildRecordTypes', args);
  }
  getCreatablePluginExtensions(): ReturnType<MEditClient['getCreatablePluginExtensions']> {
    return this.query('getCreatablePluginExtensions', []);
  }
  getRecords(...args: Parameters<MEditClient['getRecords']>): ReturnType<MEditClient['getRecords']> {
    return this.query('getRecords', args);
  }
  searchRecords(...args: Parameters<MEditClient['searchRecords']>): ReturnType<MEditClient['searchRecords']> {
    return this.query('searchRecords', args);
  }
  getRecordOwner(...args: Parameters<MEditClient['getRecordOwner']>): ReturnType<MEditClient['getRecordOwner']> {
    return this.query('getRecordOwner', args);
  }
  getRecordHolders(...args: Parameters<MEditClient['getRecordHolders']>): ReturnType<MEditClient['getRecordHolders']> {
    return this.query('getRecordHolders', args);
  }
  getRecordsWithChildren(
    ...args: Parameters<MEditClient['getRecordsWithChildren']>
  ): ReturnType<MEditClient['getRecordsWithChildren']> {
    return this.query('getRecordsWithChildren', args);
  }
  getChildrenInDestinations(
    ...args: Parameters<MEditClient['getChildrenInDestinations']>
  ): ReturnType<MEditClient['getChildrenInDestinations']> {
    return this.query('getChildrenInDestinations', args);
  }
  getRenderedDocument(...args: Parameters<MEditClient['getRenderedDocument']>): ReturnType<MEditClient['getRenderedDocument']> {
    return this.query('getRenderedDocument', args);
  }

  getRecordFile(...args: Parameters<MEditClient['getRecordFile']>): ReturnType<MEditClient['getRecordFile']> {
    return this.query('getRecordFile', args);
  }

  getRecordOfFile(...args: Parameters<MEditClient['getRecordOfFile']>): ReturnType<MEditClient['getRecordOfFile']> {
    return this.query('getRecordOfFile', args);
  }

  getComparison(...args: Parameters<MEditClient['getComparison']>): ReturnType<MEditClient['getComparison']> {
    return this.query('getComparison', args);
  }
  getRecordsComparison(
    ...args: Parameters<MEditClient['getRecordsComparison']>
  ): ReturnType<MEditClient['getRecordsComparison']> {
    return this.query('getRecordsComparison', args);
  }
  getReferences(...args: Parameters<MEditClient['getReferences']>): ReturnType<MEditClient['getReferences']> {
    return this.query('getReferences', args);
  }
  getEditChanges(...args: Parameters<MEditClient['getEditChanges']>): ReturnType<MEditClient['getEditChanges']> {
    return this.query('getEditChanges', args);
  }
  getWorldspaces(...args: Parameters<MEditClient['getWorldspaces']>): ReturnType<MEditClient['getWorldspaces']> {
    return this.query('getWorldspaces', args);
  }
  getWorldspaceBlocks(
    ...args: Parameters<MEditClient['getWorldspaceBlocks']>
  ): ReturnType<MEditClient['getWorldspaceBlocks']> {
    return this.query('getWorldspaceBlocks', args);
  }
  getCellChildRecords(
    ...args: Parameters<MEditClient['getCellChildRecords']>
  ): ReturnType<MEditClient['getCellChildRecords']> {
    return this.query('getCellChildRecords', args);
  }
  getInteriorCells(...args: Parameters<MEditClient['getInteriorCells']>): ReturnType<MEditClient['getInteriorCells']> {
    return this.query('getInteriorCells', args);
  }
  getContainerChildren(
    ...args: Parameters<MEditClient['getContainerChildren']>
  ): ReturnType<MEditClient['getContainerChildren']> {
    return this.query('getContainerChildren', args);
  }
  setFilter(...args: Parameters<MEditClient['setFilter']>): ReturnType<MEditClient['setFilter']> {
    return this.query('setFilter', args);
  }
  clearFilter(): ReturnType<MEditClient['clearFilter']> { return this.query('clearFilter', []); }
  getActiveFilter(): ReturnType<MEditClient['getActiveFilter']> { return this.query('getActiveFilter', []); }
}

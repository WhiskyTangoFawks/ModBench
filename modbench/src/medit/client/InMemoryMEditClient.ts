import type { MEditClient, NotificationKind, NotificationEvent, BackendStatus } from './MEditClient';

// Every query and command a test can script; `putLoadOrder` counts as a command here — the
// distinction is architectural, not behavioural.
type QueryMethod =
  | 'getPlugins' | 'getDiagnoses' | 'getRecordTypes' | 'getRecords' | 'searchRecords'
  | 'getRecordOwner' | 'getRecordOverridePlugins' | 'peekNextFreeFormKey' | 'getReferences'
  | 'getWorldspaces' | 'getWorldspaceBlocks' | 'getCellReferences' | 'getInteriorCells'
  | 'getContainerChildren' | 'implicitMasters' | 'setFilter' | 'clearFilter' | 'getActiveFilter';

type CommandMethod =
  | 'createPlugin' | 'rebuildIndex' | 'track' | 'createRecord' | 'deleteRecord' | 'renumberRecord'
  | 'copyRecordAsOverride' | 'copyRecordAsNewRecord' | 'compile' | 'absorbUpstreamUpdate'
  | 'keepAsMyEdit' | 'rebaseOntoMain' | 'continueRebase' | 'editRecord' | 'putLoadOrder';

type Answer<K extends keyof MEditClient> = Awaited<ReturnType<Extract<MEditClient[K], (...a: never[]) => unknown>>>;

export interface RecordedCall {
  method: string;
  args: unknown[];
}

/** The in-memory adapter (ADR-0022): a test scripts each answer/result by method name, drives
 *  notifications with `emit`, and reads every recorded call back. An unscripted query rejects,
 *  so a forgotten script fails loudly, not silently empty. */
export class InMemoryMEditClient implements MEditClient {
  readonly calls: RecordedCall[] = [];

  private readonly queryAnswers = new Map<QueryMethod, unknown>();
  private readonly commandResults = new Map<CommandMethod, unknown>();
  private readonly listeners = new Map<NotificationKind, Set<(event: NotificationEvent) => void>>();
  private readonly statusListeners = new Set<(status: BackendStatus) => void>();
  private _status: BackendStatus = 'starting';

  setQueryAnswer<K extends QueryMethod>(method: K, answer: Answer<K>): void {
    this.queryAnswers.set(method, answer);
  }

  setCommandResult<K extends CommandMethod>(method: K, result: Answer<K>): void {
    this.commandResults.set(method, result);
  }

  get status(): BackendStatus { return this._status; }

  setStatus(status: BackendStatus): void {
    this._status = status;
    for (const listener of this.statusListeners) listener(status);
  }

  // One call: the backend goes disconnected and every query starts rejecting, same as a real
  // disconnected backend's read side.
  disconnected(): void {
    this.queryAnswers.clear();
    this.setStatus('disconnected');
  }

  onStatusChanged(listener: (status: BackendStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => { this.statusListeners.delete(listener); };
  }

  start(): Promise<void> { this.record('start', []); return Promise.resolve(); }
  stop(): Promise<void> { this.record('stop', []); return Promise.resolve(); }

  subscribe(kind: NotificationKind, listener: (event: NotificationEvent) => void): () => void {
    this.record('subscribe', [kind]);
    const set = this.listeners.get(kind) ?? new Set();
    set.add(listener);
    this.listeners.set(kind, set);
    return () => { set.delete(listener); };
  }

  emit(event: NotificationEvent): void {
    for (const listener of this.listeners.get(event.kind as NotificationKind) ?? []) listener(event);
  }

  private record(method: string, args: unknown[]): void {
    this.calls.push({ method, args });
  }

  private query<T>(method: QueryMethod, args: unknown[]): Promise<T> {
    this.record(method, args);
    if (!this.queryAnswers.has(method)) {
      return Promise.reject(new Error(`InMemoryMEditClient: no scripted answer for query "${method}"`));
    }
    return Promise.resolve(this.queryAnswers.get(method) as T);
  }

  private command<T>(method: CommandMethod, args: unknown[]): Promise<T> {
    this.record(method, args);
    if (!this.commandResults.has(method)) {
      return Promise.reject(new Error(`InMemoryMEditClient: no scripted result for command "${method}"`));
    }
    return Promise.resolve(this.commandResults.get(method) as T);
  }

  putLoadOrder(...args: Parameters<MEditClient['putLoadOrder']>): ReturnType<MEditClient['putLoadOrder']> {
    return this.command('putLoadOrder', args);
  }

  createPlugin(...args: Parameters<MEditClient['createPlugin']>): ReturnType<MEditClient['createPlugin']> {
    return this.command('createPlugin', args);
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
  deleteRecord(...args: Parameters<MEditClient['deleteRecord']>): ReturnType<MEditClient['deleteRecord']> {
    return this.command('deleteRecord', args);
  }
  renumberRecord(...args: Parameters<MEditClient['renumberRecord']>): ReturnType<MEditClient['renumberRecord']> {
    return this.command('renumberRecord', args);
  }
  copyRecordAsOverride(
    ...args: Parameters<MEditClient['copyRecordAsOverride']>
  ): ReturnType<MEditClient['copyRecordAsOverride']> {
    return this.command('copyRecordAsOverride', args);
  }
  copyRecordAsNewRecord(
    ...args: Parameters<MEditClient['copyRecordAsNewRecord']>
  ): ReturnType<MEditClient['copyRecordAsNewRecord']> {
    return this.command('copyRecordAsNewRecord', args);
  }
  compile(...args: Parameters<MEditClient['compile']>): ReturnType<MEditClient['compile']> {
    return this.command('compile', args);
  }
  absorbUpstreamUpdate(
    ...args: Parameters<MEditClient['absorbUpstreamUpdate']>
  ): ReturnType<MEditClient['absorbUpstreamUpdate']> {
    return this.command('absorbUpstreamUpdate', args);
  }
  keepAsMyEdit(...args: Parameters<MEditClient['keepAsMyEdit']>): ReturnType<MEditClient['keepAsMyEdit']> {
    return this.command('keepAsMyEdit', args);
  }
  rebaseOntoMain(...args: Parameters<MEditClient['rebaseOntoMain']>): ReturnType<MEditClient['rebaseOntoMain']> {
    return this.command('rebaseOntoMain', args);
  }
  continueRebase(...args: Parameters<MEditClient['continueRebase']>): ReturnType<MEditClient['continueRebase']> {
    return this.command('continueRebase', args);
  }
  editRecord(...args: Parameters<MEditClient['editRecord']>): ReturnType<MEditClient['editRecord']> {
    return this.command('editRecord', args);
  }

  getPlugins(): ReturnType<MEditClient['getPlugins']> { return this.query('getPlugins', []); }
  getDiagnoses(): ReturnType<MEditClient['getDiagnoses']> { return this.query('getDiagnoses', []); }
  getRecordTypes(...args: Parameters<MEditClient['getRecordTypes']>): ReturnType<MEditClient['getRecordTypes']> {
    return this.query('getRecordTypes', args);
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
  getRecordOverridePlugins(
    ...args: Parameters<MEditClient['getRecordOverridePlugins']>
  ): ReturnType<MEditClient['getRecordOverridePlugins']> {
    return this.query('getRecordOverridePlugins', args);
  }
  peekNextFreeFormKey(
    ...args: Parameters<MEditClient['peekNextFreeFormKey']>
  ): ReturnType<MEditClient['peekNextFreeFormKey']> {
    return this.query('peekNextFreeFormKey', args);
  }
  getReferences(...args: Parameters<MEditClient['getReferences']>): ReturnType<MEditClient['getReferences']> {
    return this.query('getReferences', args);
  }
  getWorldspaces(...args: Parameters<MEditClient['getWorldspaces']>): ReturnType<MEditClient['getWorldspaces']> {
    return this.query('getWorldspaces', args);
  }
  getWorldspaceBlocks(
    ...args: Parameters<MEditClient['getWorldspaceBlocks']>
  ): ReturnType<MEditClient['getWorldspaceBlocks']> {
    return this.query('getWorldspaceBlocks', args);
  }
  getCellReferences(
    ...args: Parameters<MEditClient['getCellReferences']>
  ): ReturnType<MEditClient['getCellReferences']> {
    return this.query('getCellReferences', args);
  }
  getInteriorCells(...args: Parameters<MEditClient['getInteriorCells']>): ReturnType<MEditClient['getInteriorCells']> {
    return this.query('getInteriorCells', args);
  }
  getContainerChildren(
    ...args: Parameters<MEditClient['getContainerChildren']>
  ): ReturnType<MEditClient['getContainerChildren']> {
    return this.query('getContainerChildren', args);
  }
  implicitMasters(...args: Parameters<MEditClient['implicitMasters']>): ReturnType<MEditClient['implicitMasters']> {
    return this.query('implicitMasters', args);
  }
  setFilter(...args: Parameters<MEditClient['setFilter']>): ReturnType<MEditClient['setFilter']> {
    return this.query('setFilter', args);
  }
  clearFilter(): ReturnType<MEditClient['clearFilter']> { return this.query('clearFilter', []); }
  getActiveFilter(): ReturnType<MEditClient['getActiveFilter']> { return this.query('getActiveFilter', []); }
}

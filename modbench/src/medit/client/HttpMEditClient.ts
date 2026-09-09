import type { EditingController } from '../EditingController';
import type { PluginRepository } from '../PluginRepository';
import type { NotificationSubscriber } from '../NotificationSubscriber';
import type { BackendManager } from '../BackendManager';
import type { MEditClient, NotificationKind, NotificationEvent, BackendStatus } from './MEditClient';

export interface HttpMEditClientDeps {
  controller: EditingController;
  repository: PluginRepository;
  notificationSubscriber: NotificationSubscriber;
  backendManager: BackendManager;
}

/** Thin composition over the five modules: every method forwards to `EditingController`,
 *  `PluginRepository`, `NotificationSubscriber` or `BackendManager` unchanged. */
export class HttpMEditClient implements MEditClient {
  // BackendManager only pushes 'status' events, never offers a read of the current value, so
  // this caches the latest one for `status`/`onStatusChanged`.
  private currentStatus: BackendStatus = 'starting';
  private readonly statusListeners = new Set<(status: BackendStatus) => void>();

  constructor(private readonly deps: HttpMEditClientDeps) {
    deps.backendManager.on('status', (status: BackendStatus) => {
      this.currentStatus = status;
      for (const listener of this.statusListeners) listener(status);
    });
  }

  get status(): BackendStatus { return this.currentStatus; }

  onStatusChanged(listener: (status: BackendStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => { this.statusListeners.delete(listener); };
  }

  start(): Promise<void> { return this.deps.backendManager.start(); }
  stop(): Promise<void> { return this.deps.backendManager.stop(); }

  subscribe(kind: NotificationKind, listener: (event: NotificationEvent) => void): () => void {
    return this.deps.notificationSubscriber.subscribe(kind, listener);
  }

  putLoadOrder(...args: Parameters<MEditClient['putLoadOrder']>): ReturnType<MEditClient['putLoadOrder']> {
    return this.deps.controller.putLoadOrder(...args);
  }

  createPlugin(...args: Parameters<MEditClient['createPlugin']>): ReturnType<MEditClient['createPlugin']> {
    return this.deps.controller.createPlugin(...args);
  }
  rebuildIndex(...args: Parameters<MEditClient['rebuildIndex']>): ReturnType<MEditClient['rebuildIndex']> {
    return this.deps.controller.rebuildIndex(...args);
  }
  track(...args: Parameters<MEditClient['track']>): ReturnType<MEditClient['track']> {
    return this.deps.controller.track(...args);
  }
  createRecord(...args: Parameters<MEditClient['createRecord']>): ReturnType<MEditClient['createRecord']> {
    return this.deps.controller.createRecord(...args);
  }
  deleteRecord(...args: Parameters<MEditClient['deleteRecord']>): ReturnType<MEditClient['deleteRecord']> {
    return this.deps.controller.deleteRecord(...args);
  }
  renumberRecord(...args: Parameters<MEditClient['renumberRecord']>): ReturnType<MEditClient['renumberRecord']> {
    return this.deps.controller.renumberRecord(...args);
  }
  copyRecordAsOverride(
    ...args: Parameters<MEditClient['copyRecordAsOverride']>
  ): ReturnType<MEditClient['copyRecordAsOverride']> {
    return this.deps.controller.copyRecordAsOverride(...args);
  }
  copyRecordAsNewRecord(
    ...args: Parameters<MEditClient['copyRecordAsNewRecord']>
  ): ReturnType<MEditClient['copyRecordAsNewRecord']> {
    return this.deps.controller.copyRecordAsNewRecord(...args);
  }
  compile(...args: Parameters<MEditClient['compile']>): ReturnType<MEditClient['compile']> {
    return this.deps.controller.compile(...args);
  }
  absorbUpstreamUpdate(
    ...args: Parameters<MEditClient['absorbUpstreamUpdate']>
  ): ReturnType<MEditClient['absorbUpstreamUpdate']> {
    return this.deps.controller.absorbUpstreamUpdate(...args);
  }
  keepAsMyEdit(...args: Parameters<MEditClient['keepAsMyEdit']>): ReturnType<MEditClient['keepAsMyEdit']> {
    return this.deps.controller.keepAsMyEdit(...args);
  }
  rebaseOntoMain(...args: Parameters<MEditClient['rebaseOntoMain']>): ReturnType<MEditClient['rebaseOntoMain']> {
    return this.deps.controller.rebaseOntoMain(...args);
  }
  continueRebase(...args: Parameters<MEditClient['continueRebase']>): ReturnType<MEditClient['continueRebase']> {
    return this.deps.controller.continueRebase(...args);
  }
  editRecord(...args: Parameters<MEditClient['editRecord']>): ReturnType<MEditClient['editRecord']> {
    return this.deps.repository.editRecord(...args);
  }

  getPlugins(): ReturnType<MEditClient['getPlugins']> { return this.deps.repository.getPlugins(); }
  getDiagnoses(): ReturnType<MEditClient['getDiagnoses']> { return this.deps.repository.getDiagnoses(); }
  getRecordTypes(...args: Parameters<MEditClient['getRecordTypes']>): ReturnType<MEditClient['getRecordTypes']> {
    return this.deps.repository.getRecordTypes(...args);
  }
  getRecords(...args: Parameters<MEditClient['getRecords']>): ReturnType<MEditClient['getRecords']> {
    return this.deps.repository.getRecords(...args);
  }
  searchRecords(...args: Parameters<MEditClient['searchRecords']>): ReturnType<MEditClient['searchRecords']> {
    return this.deps.repository.searchRecords(...args);
  }
  getRecordOwner(...args: Parameters<MEditClient['getRecordOwner']>): ReturnType<MEditClient['getRecordOwner']> {
    return this.deps.repository.getRecordOwner(...args);
  }
  getRecordOverridePlugins(
    ...args: Parameters<MEditClient['getRecordOverridePlugins']>
  ): ReturnType<MEditClient['getRecordOverridePlugins']> {
    return this.deps.repository.getRecordOverridePlugins(...args);
  }
  peekNextFreeFormKey(
    ...args: Parameters<MEditClient['peekNextFreeFormKey']>
  ): ReturnType<MEditClient['peekNextFreeFormKey']> {
    return this.deps.repository.peekNextFreeFormKey(...args);
  }
  getReferences(...args: Parameters<MEditClient['getReferences']>): ReturnType<MEditClient['getReferences']> {
    return this.deps.repository.getReferences(...args);
  }
  getWorldspaces(...args: Parameters<MEditClient['getWorldspaces']>): ReturnType<MEditClient['getWorldspaces']> {
    return this.deps.repository.getWorldspaces(...args);
  }
  getWorldspaceBlocks(
    ...args: Parameters<MEditClient['getWorldspaceBlocks']>
  ): ReturnType<MEditClient['getWorldspaceBlocks']> {
    return this.deps.repository.getWorldspaceBlocks(...args);
  }
  getCellReferences(
    ...args: Parameters<MEditClient['getCellReferences']>
  ): ReturnType<MEditClient['getCellReferences']> {
    return this.deps.repository.getCellReferences(...args);
  }
  getInteriorCells(...args: Parameters<MEditClient['getInteriorCells']>): ReturnType<MEditClient['getInteriorCells']> {
    return this.deps.repository.getInteriorCells(...args);
  }
  getContainerChildren(
    ...args: Parameters<MEditClient['getContainerChildren']>
  ): ReturnType<MEditClient['getContainerChildren']> {
    return this.deps.repository.getContainerChildren(...args);
  }
  implicitMasters(...args: Parameters<MEditClient['implicitMasters']>): ReturnType<MEditClient['implicitMasters']> {
    return this.deps.controller.implicitMasters(...args);
  }
  setFilter(...args: Parameters<MEditClient['setFilter']>): ReturnType<MEditClient['setFilter']> {
    return this.deps.repository.setFilter(...args);
  }
  clearFilter(): ReturnType<MEditClient['clearFilter']> { return this.deps.repository.clearFilter(); }
  getActiveFilter(): ReturnType<MEditClient['getActiveFilter']> { return this.deps.repository.getActiveFilter(); }
}

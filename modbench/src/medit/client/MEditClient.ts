import type { components } from '../generated/api';
import type {
  CompileResult, RebaseResult, CrashRepairOffer, ExternalChangeActionResult, NotificationEvent,
  TrackStatus, PluginMetadata, PluginDiagnosisReport, WorldspaceSummary, WorldspaceBlocks,
  CellReferences, ContainerChildSummary,
} from '../ApiClient';
import type { WriteRefused, LoadOrderOutcome, LoadOrderOptions, LoadOrderPluginInput } from '../EditingController';
import type { RecordEditOutcome, RecordPage, CellPage, PluginRecordTypeCount } from '../PluginRepository';
import type { NotificationKind } from '../NotificationSubscriber';
import type { BackendStatus } from '../BackendManager';
import type { RecordEditEnvelope } from '../messages';

export type { WriteRefused, LoadOrderOutcome, LoadOrderOptions, LoadOrderPluginInput, NotificationKind, NotificationEvent, BackendStatus };
export { isRefused } from '../EditingController';

// ApiClient.ts aliases the wire shapes its own module needs; these are the port's own, named
// here for the same reason (modbench/CLAUDE.md: the generated schema is the frontend type).
export type PluginCreatedResponse = components['schemas']['PluginCreatedResponse'];
export type TrackResponse = components['schemas']['TrackResponse'];
export type RecordCreateResponse = components['schemas']['RecordCreateResponse'];
export type RecordDeleteResponse = components['schemas']['RecordDeleteResponse'];
export type RecordRenumberResponse = components['schemas']['RecordRenumberResponse'];
export type RecordCopyAsOverrideResponse = components['schemas']['RecordCopyAsOverrideResponse'];
export type RecordCopyAsNewRecordResponse = components['schemas']['RecordCopyAsNewRecordResponse'];
export type ReferenceResult = components['schemas']['ReferenceResult'];

/** The extension's side of the backend seam (ADR-0022; target-architecture.d2's "mEdit client"
 *  box), hiding whichever adapter is wired in and the process itself. Names nothing HTTP, no
 *  port number, no generated client. */
export interface MEditClient {
  // Commands — the controller's verbs by today's names, each answering applied-or-refusal;
  // `rebuildIndex` is a command too, in its own pre-existing shape.
  createPlugin(name: string, path: string, origin: string): Promise<PluginCreatedResponse | WriteRefused>;
  rebuildIndex(
    instanceRoot: string, onFailure: (message: string, detail: string) => void, gameRelease: string,
  ): Promise<boolean>;
  track(
    origin: string, preset: 'Edits' | 'Everything', options?: { onProgress?: (status: TrackStatus) => void },
  ): Promise<TrackResponse | WriteRefused>;
  createRecord(
    plugin: string, origin: string, recordType: string, editorId?: string, formKey?: string,
    onEslContradiction?: (message: string) => Promise<boolean>,
  ): Promise<RecordCreateResponse | WriteRefused | undefined>;
  deleteRecord(formKey: string, plugin: string, origin: string): Promise<RecordDeleteResponse | WriteRefused | undefined>;
  renumberRecord(
    formKey: string, plugin: string, origin: string, newFormKey?: string,
  ): Promise<RecordRenumberResponse | WriteRefused | undefined>;
  copyRecordAsOverride(
    formKey: string, sourcePlugin: string, sourceOrigin: string, destinationPlugin: string, destinationOrigin: string,
  ): Promise<RecordCopyAsOverrideResponse | WriteRefused | undefined>;
  copyRecordAsNewRecord(
    formKey: string, sourcePlugin: string, sourceOrigin: string, destinationPlugin: string, destinationOrigin: string,
    requestedFormKey?: string, onEslContradiction?: (message: string) => Promise<boolean>,
  ): Promise<RecordCopyAsNewRecordResponse | WriteRefused | undefined>;
  compile(plugin: string, origin: string, atRef?: string): Promise<CompileResult | WriteRefused | undefined>;
  absorbUpstreamUpdate(plugin: string, origin: string): Promise<ExternalChangeActionResult | WriteRefused | undefined>;
  keepAsMyEdit(plugin: string, origin: string): Promise<ExternalChangeActionResult | WriteRefused | undefined>;
  rebaseOntoMain(origin: string): Promise<RebaseResult | WriteRefused | undefined>;
  continueRebase(origin: string): Promise<RebaseResult | WriteRefused | undefined>;
  // Today's `PluginRepository.editRecord`, grouped here per the ruling: "edit (today the
  // repository's)".
  editRecord(formKey: string, plugin: string, origin: string, envelope: RecordEditEnvelope): Promise<RecordEditOutcome>;

  // Queries — the repository's read methods, by their current names, plus implicit masters and
  // the filter facet (set filter, clear filter, active filter).
  getPlugins(): Promise<PluginMetadata[]>;
  getDiagnoses(): Promise<PluginDiagnosisReport[]>;
  getRecordTypes(plugin: string, origin?: string): Promise<PluginRecordTypeCount[]>;
  getRecords(plugin: string, type: string, offset: number, limit: number, origin?: string): Promise<RecordPage>;
  searchRecords(query: string, validTypes: string[]): Promise<RecordPage>;
  getRecordOwner(formKey: string): Promise<{ plugin: string; origin: string } | undefined>;
  getRecordOverridePlugins(formKey: string): Promise<string[]>;
  peekNextFreeFormKey(plugin: string, origin: string): Promise<string>;
  getReferences(formKey: string): Promise<ReferenceResult[]>;
  getWorldspaces(plugin: string, origin?: string): Promise<WorldspaceSummary[]>;
  getWorldspaceBlocks(plugin: string, worldspaceFormKey: string, origin?: string): Promise<WorldspaceBlocks>;
  getCellReferences(plugin: string, cellFormKey: string, origin?: string): Promise<CellReferences>;
  getInteriorCells(plugin: string, offset: number, limit: number, origin?: string): Promise<CellPage>;
  getContainerChildren(plugin: string, parentFormKey: string, origin?: string): Promise<ContainerChildSummary[]>;
  implicitMasters(gameDirectory: string, gameRelease: string): Promise<string[] | undefined>;
  setFilter(sql: string): Promise<string | null>;
  clearFilter(): Promise<void>;
  getActiveFilter(): Promise<string | null>;

  // Subscribe by kind (ADR-0046 invariant 12) — today's signature, unchanged.
  subscribe(kind: NotificationKind, listener: (event: NotificationEvent) => void): () => void;

  // The load-order snapshot — the controller's own signature and return, unchanged.
  putLoadOrder(
    plugins: LoadOrderPluginInput[], gameDirectory: string, instanceRoot: string, gameRelease: string,
    options?: LoadOrderOptions,
  ): Promise<LoadOrderOutcome>;

  // The backend process: today's four values, read as a current value and observed through a
  // status-changed event.
  readonly status: BackendStatus;
  onStatusChanged(listener: (status: BackendStatus) => void): () => void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export type { CrashRepairOffer };

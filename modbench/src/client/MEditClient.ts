import type { components } from '../wire/generated/api';
import {
  CRASH_REPAIR_REASONS,
  type CompileResult, type RebaseResult, type CrashRepairOffer, type CrashRepairReason,
  type ExternalChangeActionResult, type NotificationEvent,
  type TrackStatus, type PluginMetadata, type PluginDiagnosisReport, type WorkingTreeState, type MasterIssue,
  type WorldspaceSummary, type WorldspaceBlocks, type WorldspaceBlock, type WorldspaceSubBlock,
  type CellReferences, type CellSummary,
  type PlacedSummary, type ContainerChildSummary, type RecordSummary, type LoadOrderStatus,
  type UnansweredExternalChange, type PluginLoadFailure,
} from './apiClient';
import type { RecordEditEnvelope } from '../wire/messages';

/** What `editRecord` is handed. Re-exported because a caller of the one write path names this
 *  type, and the client is the seam it reaches the backend through (ADR-0007). */
export type { RecordEditEnvelope } from '../wire/messages';

/** The backend process as the extension reports it: starting while it comes up, attached while
 *  it answers, disconnected when it has gone, stopped when the extension took it down. */
export type BackendStatus = 'starting' | 'attached' | 'disconnected' | 'stopped';

/** A write verb's outright refusal — non-2xx, a thrown request, or write-gate contention.
 *  `message` is the ready-to-show toast (ADR-0019); a 200 typed refusal lives on the success arm. */
export interface WriteRefused {
  readonly refused: true;
  readonly message: string;
}

/** `WriteRefused`'s one structural tag — a plain check, not `instanceof`, so a scripted client's
 *  plain object narrows the same way the real one does. On the port, so narrowing never drags
 *  the HTTP adapter into a caller's test. */
export function isRefused(result: unknown): result is WriteRefused {
  return typeof result === 'object' && result !== null && (result as { refused?: unknown }).refused === true;
}

/** The wire's five kinds, narrowed from the schema's honest `string` for a typed `subscribe` call
 *  — not a mirror of `NotificationEvent`, which keeps every field as the schema reports it. */
export type NotificationKind =
  | 'rows-changed' | 'plugin-changed' | 'load-order-status' | 'track-progress' | 'question-open';

const NOTIFICATION_KINDS = new Set<string>([
  'rows-changed', 'plugin-changed', 'load-order-status', 'track-progress', 'question-open',
]);

/** Whether `kind` is one of the five the wire defines — the one place `NotificationEvent.kind`
 *  (the schema's honest `string`) is narrowed to `NotificationKind` for dispatch. */
export function isNotificationKind(kind: string): kind is NotificationKind {
  return NOTIFICATION_KINDS.has(kind);
}

const CRASH_REPAIR_REASON_SET = new Set<string>(CRASH_REPAIR_REASONS);

/** `question-open`'s `crashRepairReason` (the schema's honest `string`) narrowed to
 *  `CrashRepairReason`, on the port for the same reason `isRefused` is. */
export function isCrashRepairReason(reason: string): reason is CrashRepairReason {
  return CRASH_REPAIR_REASON_SET.has(reason);
}

/** Re-exported under its own name because it is a callback contract, not merely a query return
 *  type the caller happens to see. */
export type LoadOrderProgress = LoadOrderStatus;

/** Restated rather than imported from Mod Management's own snapshot type: this module belongs
 *  to Editing, which imports nothing from Mod Management. `slot` is null when no plugins.txt
 *  line names this copy. */
export interface LoadOrderPluginInput {
  name: string;
  path: string;
  origin: string;
  slot: number | null;
  enabled: boolean;
  winning: boolean;
}

/** A tagged union, not a sentinel value. `abandoned`: a newer snapshot replaced this one before
 *  it was sent, or mEdit closed mid-flight. `applied` carries the terminal status the Index
 *  reached, never read off the PUT alone. */
export type LoadOrderOutcome =
  | { outcome: 'applied'; status: LoadOrderProgress }
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

/** A refusal is an outcome, not an exception: `refusal` carries the backend's own name for it,
 *  which lets a caller offer Track for one and the patch-plugin path for another. `'Unknown'` is
 *  this side's own addition. */
export type RecordEditOutcome =
  | { applied: true }
  | { applied: false; refusal: string; message: string };

export type PluginRecordTypeCount = components['schemas']['PluginRecordTypeCount'];
export type RecordPage = components['schemas']['RecordSummaryPagedResult'];
export type CellPage = components['schemas']['CellSummaryPagedResult'];

// apiClient.ts aliases the wire shapes its own module needs; these are the port's own, named
// here for the same reason (modbench/CLAUDE.md: the generated schema is the frontend type).
export type PluginCreatedResponse = components['schemas']['PluginCreatedResponse'];
export type TrackResponse = components['schemas']['TrackResponse'];
export type RecordCreateResponse = components['schemas']['RecordCreateResponse'];
export type RecordDeleteResponse = components['schemas']['RecordDeleteResponse'];
export type RecordRenumberResponse = components['schemas']['RecordRenumberResponse'];
export type RecordCopyAsOverrideResponse = components['schemas']['RecordCopyAsOverrideResponse'];
export type RecordCopyAsNewRecordResponse = components['schemas']['RecordCopyAsNewRecordResponse'];
export type ReferenceResult = components['schemas']['ReferenceResult'];

/** The extension's side of the backend seam (ADR-0002; target-architecture.d2's "mEdit client"
 *  box), hiding whichever adapter is wired in and the process itself. Names nothing HTTP, no
 *  port number, no generated client. */
export interface MEditClient {
  // Commands — the HTTP adapter's verbs by today's names, each answering applied-or-refusal;
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
  // Origin-scoped, like rebase: the mod, not one plugin in it, is the unit both answers cover.
  absorbUpstreamUpdate(origin: string): Promise<ExternalChangeActionResult | WriteRefused | undefined>;
  keepAsMyEdit(origin: string): Promise<ExternalChangeActionResult | WriteRefused | undefined>;
  rebaseOntoMain(origin: string): Promise<RebaseResult | WriteRefused | undefined>;
  continueRebase(origin: string): Promise<RebaseResult | WriteRefused | undefined>;
  // Today's field-edit write, grouped here per the ruling: "edit (today the repository's)".
  editRecord(formKey: string, plugin: string, origin: string, envelope: RecordEditEnvelope): Promise<RecordEditOutcome>;

  // Queries — the read verbs, by their current names, plus implicit masters and the filter
  // facet (set filter, clear filter, active filter).
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

  // Subscribe by kind (ADR-0014 invariant 2) — today's signature, unchanged.
  subscribe(kind: NotificationKind, listener: (event: NotificationEvent) => void): () => void;

  // The load-order snapshot — today's own signature and return, unchanged.
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

export type {
  CrashRepairOffer, CrashRepairReason, NotificationEvent, TrackStatus, PluginMetadata, PluginDiagnosisReport, WorkingTreeState,
  MasterIssue, RecordSummary, WorldspaceSummary, WorldspaceBlocks, WorldspaceBlock, WorldspaceSubBlock,
  CellReferences, CellSummary, PlacedSummary, ContainerChildSummary, CompileResult, RebaseResult,
  ExternalChangeActionResult, LoadOrderStatus, UnansweredExternalChange, PluginLoadFailure,
};

import type { components } from '../wire/generated/api';
import {
  type CompiledPlugin, type CompileDiagnostic,
  type NotificationEvent,
  type TrackStatus, type PluginMetadata, type PluginDiagnosisReport, type WorkingTreeState,
  type WorldspaceSummary, type WorldspaceBlocks, type WorldspaceBlock, type WorldspaceSubBlock,
  type CellReferences, type CellSummary,
  type PlacedSummary, type ContainerChildSummary, type RecordSummary, type LoadOrderStatus, type LoadOrderRefusal,
  type PluginLoadFailure, type CompareResult,
} from './apiClient';
import type { RecordEditEnvelope } from '../wire/messages';
import type { ItemRefusal, SelectionOutcome } from '../ports/selectionOutcome';

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

const NOTIFICATION_KINDS = [
  'rows-changed', 'plugin-changed', 'load-order-status', 'track-progress', 'external-change',
  'untracked-plugins',
] as const;

/** The wire's kinds, narrowed from the schema's honest `string` for a typed `subscribe` call
 *  — not a mirror of `NotificationEvent`, which keeps every field as the schema reports it. */
export type NotificationKind = typeof NOTIFICATION_KINDS[number];

/** Whether the wire defines `kind` — the one place `NotificationEvent.kind` (the schema's honest
 *  `string`) is narrowed to `NotificationKind` for dispatch. */
export function isNotificationKind(kind: string): kind is NotificationKind {
  return (NOTIFICATION_KINDS as readonly string[]).includes(kind);
}

/** Re-exported under its own name because it is a callback contract, not merely a query return
 *  type the caller happens to see. */
export type LoadOrderProgress = LoadOrderStatus;

/** Restated rather than imported from Mod Management's own snapshot type: this module belongs
 *  to Editing, which imports nothing from Mod Management. */
export interface LoadOrderPluginInput {
  name: string;
  path: string;
  origin: string;
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
  /** Trips when the user deliberately abandons this reconcile (closing mEdit). Aborts the PUT
   *  itself rather than waiting for a dead socket. */
  signal?: AbortSignal;
}

/** A refusal is an outcome, not an exception: `refusal` is the backend's own name for it, and
 *  `'Unknown'` this side's own addition. `newFormKey` is set by an edit of the FormID. */
export type RecordEditOutcome =
  | { applied: true; newFormKey?: string }
  | { applied: false; refusal: string; message: string };

/** `rebuildIndex`'s own outcome (ADR-0009 invariant 5): a 423 — this instance's index held by
 *  another window — is told apart from every other failure, which carries its own detail. */
export type RebuildIndexOutcome =
  | { rebuilt: true }
  | { rebuilt: false; heldElsewhere: true }
  | { rebuilt: false; heldElsewhere: false; detail: string };

/** `/records` takes a plain `int` limit with no upper bound, so Int32.MaxValue lists every record
 *  of a group in one page. */
export const UNLIMITED_RECORDS = 2147483647;

export type PluginRecordTypeCount = components['schemas']['PluginRecordTypeCount'];
export type CreatableRecordType = components['schemas']['CreatableRecordType'];
export type RecordPage = components['schemas']['RecordSummaryPagedResult'];
export type InteriorCellBlock = components['schemas']['InteriorCellBlock'];
export type InteriorCellSubBlock = components['schemas']['InteriorCellSubBlock'];

// apiClient.ts aliases the wire shapes its own module needs; these are the port's own, named
// here for the same reason (modbench/CLAUDE.md: the generated schema is the frontend type).
export type PluginCreatedResponse = components['schemas']['PluginCreatedResponse'];
/** A plugin named by filename and origin (ADR-0012 invariant 1): one filename can be in two mods. */
export type PluginAddress = components['schemas']['PluginAddress'];
export type UpstreamVersionByOrigin = components['schemas']['TrackRequest']['upstreamVersionByOrigin'];

/** Compile's answer: each plugin compiled, with its diagnostics, or refused with its reason. */
export interface CompileOutcome {
  landed: readonly CompiledPlugin[];
  refused: readonly ItemRefusal<PluginAddress>[];
}

export type RecordCreateResponse = components['schemas']['RecordCreateResponse'];
/** A record and the plugin holding it, named by filename and origin (ADR-0012 invariant 1): one
 *  filename can be in two mods, each holding the record. */
export type RecordAddress = components['schemas']['RecordAddress'];
/** Copy's mode Option (commands.md, Record, `copy`). */
export type CopyMode = components['schemas']['CopyMode'];
/** One record into one destination: the unit a copy lands or is refused by. */
export type CopyItem = Pick<components['schemas']['RecordCopyLanded'], 'record' | 'destination'>;
export type ReferenceResult = components['schemas']['ReferenceResult'];
/** The record filter mEdit holds: its SQL and the name of the source it came from
 *  (plugins.md, Record filter). */
export type RecordFilter = components['schemas']['FilterRequest'];

/** The extension's side of the backend seam (ADR-0002; target-architecture.d2's "mEdit client"
 *  box), hiding whichever adapter is wired in and the process itself. Names nothing HTTP, no
 *  port number, no generated client. */
export interface MEditClient {
  // Commands — the HTTP adapter's verbs by today's names, each answering applied-or-refusal;
  // `rebuildIndex` answers with its own outcome shape (RebuildIndexOutcome).
  createPlugin(plugin: PluginAddress, folder: string): Promise<PluginCreatedResponse | WriteRefused>;
  rebuildIndex(instanceRoot: string, gameRelease: string): Promise<RebuildIndexOutcome>;
  track(
    plugins: readonly PluginAddress[], preset: 'Edits' | 'Everything', upstreamVersionByOrigin: UpstreamVersionByOrigin,
    options?: { onProgress?: (status: TrackStatus) => void },
  ): Promise<SelectionOutcome<PluginAddress> | WriteRefused>;
  createRecord(plugin: string, origin: string, recordType: string): Promise<RecordCreateResponse | WriteRefused>;
  // The whole selection is one call; each record lands or is refused on its own (ADR-0019
  // invariant 4). A WriteRefused is the call itself failing, with nothing deleted.
  deleteRecords(records: readonly RecordAddress[]): Promise<SelectionOutcome<RecordAddress> | WriteRefused>;
  // Each record into each destination is one item, landed or refused on its own. `replace` lets an
  // override copy over the one a destination already holds.
  copyRecords(
    records: readonly RecordAddress[], mode: CopyMode, destinations: readonly PluginAddress[], replace: boolean,
  ): Promise<SelectionOutcome<CopyItem> | WriteRefused>;
  // Each plugin's source is replaced from its bytes, or it is refused, on its own. A WriteRefused is
  // the call itself refused, with nothing written.
  decompile(plugins: readonly PluginAddress[]): Promise<SelectionOutcome<PluginAddress> | WriteRefused>;
  // The whole selection is one call; each plugin compiles or is refused on its own (ADR-0019
  // invariant 4). A WriteRefused is the call itself refused, with nothing written.
  compile(plugins: readonly PluginAddress[]): Promise<CompileOutcome | WriteRefused>;
  // Today's field-edit write, grouped here per the ruling: "edit (today the repository's)".
  editRecord(formKey: string, plugin: string, origin: string, envelope: RecordEditEnvelope): Promise<RecordEditOutcome>;

  // Queries — the read verbs, by their current names, plus the filter facet (set filter, clear
  // filter, active filter).
  getPlugins(): Promise<PluginMetadata[]>;
  getDiagnoses(): Promise<PluginDiagnosisReport[]>;
  getRecordTypes(plugin: string, origin: string): Promise<PluginRecordTypeCount[]>;
  // The game's, not a plugin's: every plugin of the load order shares it.
  getCreatableRecordTypes(): Promise<CreatableRecordType[]>;
  getLightPluginsSupported(): Promise<boolean>;
  // `unfiltered` lists what the record filter hides too.
  getRecords(
    plugin: string, type: string, offset: number, limit: number, origin: string, options?: { unfiltered: boolean },
  ): Promise<RecordPage>;
  searchRecords(query: string, validTypes: string[]): Promise<RecordPage>;
  getRecordOwner(formKey: string): Promise<{ plugin: string; origin: string } | undefined>;
  /** Every plugin that holds a copy of the record, its own included. */
  getRecordHolders(formKey: string): Promise<PluginAddress[]>;
  /** One record as every active plugin has it: the record panel's host asks for this and posts it
   *  to the webview untransformed (target-architecture.d2 `modbench_driving.editor`). */
  getComparison(formKey: string): Promise<CompareResult>;
  getReferences(formKey: string): Promise<ReferenceResult[]>;
  getWorldspaces(plugin: string, origin: string): Promise<WorldspaceSummary[]>;
  getWorldspaceBlocks(plugin: string, worldspaceFormKey: string, origin: string): Promise<WorldspaceBlocks>;
  getCellReferences(plugin: string, cellFormKey: string, origin: string): Promise<CellReferences>;
  getInteriorCells(plugin: string, origin: string): Promise<InteriorCellBlock[]>;
  getContainerChildren(plugin: string, parentFormKey: string, origin: string): Promise<ContainerChildSummary[]>;
  /** Null when mEdit took the filter, or the reason it did not. */
  setFilter(filter: RecordFilter): Promise<string | null>;
  /** Null when mEdit dropped the filter, or the reason it did not. */
  clearFilter(): Promise<string | null>;
  getActiveFilter(): Promise<RecordFilter | null>;

  // Subscribe by kind (ADR-0014 invariant 2) — today's signature, unchanged.
  subscribe(kind: NotificationKind, listener: (event: NotificationEvent) => void): () => void;

  // The load-order snapshot (ADR-0013): every plugin in the instance, and the active plugins in
  // load order.
  putLoadOrder(
    plugins: LoadOrderPluginInput[], active: PluginAddress[], gameDirectory: string, instanceRoot: string,
    gameRelease: string, options?: LoadOrderOptions,
  ): Promise<LoadOrderOutcome>;

  // The backend process: today's four values, read as a current value and observed through a
  // status-changed event.
  readonly status: BackendStatus;
  onStatusChanged(listener: (status: BackendStatus) => void): () => void;
  /** The notification stream opened again while `attached`. The client attaches to any healthy
   *  backend on its port, so the process behind the stream may be another, holding nothing sent
   *  before. */
  onReconnected(listener: () => void): () => void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export type {
  NotificationEvent, TrackStatus, PluginMetadata, PluginDiagnosisReport, WorkingTreeState,
  RecordSummary, WorldspaceSummary, WorldspaceBlocks, WorldspaceBlock, WorldspaceSubBlock,
  CellReferences, CellSummary, PlacedSummary, ContainerChildSummary, CompiledPlugin, CompileDiagnostic,
  LoadOrderStatus, LoadOrderRefusal, PluginLoadFailure, CompareResult,
};

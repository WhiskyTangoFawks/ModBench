import type { components } from '../wire/generated/api';
import {
  type CompiledPlugin, type CompileDiagnostic,
  type ChangedPlugin,
  type TrackStatus, type PluginMetadata, type PluginDiagnosisReport, type WorkingTreeState,
  type WorldspaceSummary, type WorldspaceBlocks, type WorldspaceBlock, type WorldspaceSubBlock,
  type CellChildRecords, type CellSummary,
  type ChildRecordSummary, type ContainerChildSummary, type RecordSummary, type LoadOrderStatus, type LoadOrderRefusal,
  type PluginLoadFailure, type CompareResult, type RecordCopy, type CopyText,
} from './apiClient';
import type { RecordEditEnvelope } from '../wire/messages';
import type { PluginAddress } from '../wire/pluginAddress';
import type { ItemRefusal, SelectionOutcome } from '../ports/selectionOutcome';

/** What `editRecord` is handed, re-exported because its caller reaches the backend only through
 *  this port. */
export type { RecordEditEnvelope } from '../wire/messages';

/** The backend process as the extension reports it: starting while it comes up, running while
 *  it answers, disconnected when it has gone, stopped when the extension took it down. */
export type BackendStatus = 'starting' | 'running' | 'disconnected' | 'stopped';

export function isMEditGone(status: BackendStatus): status is 'disconnected' | 'stopped' {
  return status === 'disconnected' || status === 'stopped';
}

/** A write verb's outright refusal — non-2xx, a thrown request, or write-gate contention.
 *  `message` is the ready-to-show toast (common.md, Reporting); a 200 typed refusal lives on the
 *  success arm. */
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

/** The wire's kinds, narrowed from the schema's honest `string` for a typed `onNotification` call
 *  — not a mirror of `NotificationEvent`, which keeps every field as the schema reports it. */
export type NotificationKind = typeof NOTIFICATION_KINDS[number];

/** Each kind's payload as `onNotification` hands it over: a transform of the flat wire
 *  `NotificationEvent`, carrying only the fields its kind uses. */
export interface NotificationPayloads {
  'load-order-status': LoadOrderStatus;
  'track-progress': TrackStatus;
  'external-change': { origin: string; changedPlugins: ChangedPlugin[] };
  'untracked-plugins': { plugins: PluginAddress[] };
  'rows-changed': { plugin: PluginAddress; keys: string[] };
  'plugin-changed': { plugin: PluginAddress };
}

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
  provider: components['schemas']['PluginProviderRequest'];
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

/** An edit answered as the changes it makes to plugin source, or the refusal the edit gives:
 *  each move first, then each document's new text at its path once moved. */
export type RecordEditChangesOutcome =
  | ({ applied: true; newFormKey?: string } & Pick<components['schemas']['RecordEditChangesResponse'], 'moves' | 'documents'>)
  | { applied: false; refusal: string; message: string };

/** `rebuildIndex`'s own outcome (ADR-0010). */
export type RebuildIndexOutcome =
  | { rebuilt: true }
  | { rebuilt: false; heldElsewhere: true }
  | { rebuilt: false; heldElsewhere: false; detail: string };

/** `/records` takes a plain `int` limit with no upper bound, so Int32.MaxValue lists every record
 *  of a group in one page. */
export const UNLIMITED_RECORDS = 2147483647;

/** The plugins that list a plugin's file name as a master, and the plugins whose masters mEdit could
 *  not read. */
export type PluginDependants = components['schemas']['PluginDependantsResponse'];
export type PluginRecordTypeCount = components['schemas']['PluginRecordTypeCount'];
export type CreatableRecordType = components['schemas']['CreatableRecordType'];
export type RecordPage = components['schemas']['RecordSummaryPagedResult'];
export type InteriorCellBlock = components['schemas']['InteriorCellBlock'];
export type InteriorCellSubBlock = components['schemas']['InteriorCellSubBlock'];

// apiClient.ts aliases the wire shapes its own module needs; these are the port's own, named
// here for the same reason (modbench/CLAUDE.md: the generated schema is the frontend type).
export type PluginCreatedResponse = components['schemas']['PluginCreatedResponse'];
export type { PluginAddress };

/** A mod of Track's selection that tracked: the plugins whose source landed in its commit, and those
 *  of it that did not, each with its reason. */
export interface TrackedMod {
  mod: string;
  tracked: readonly PluginAddress[];
  refused: readonly ItemRefusal<PluginAddress>[];
}

/** Track's answer: each mod tracked or refused, as a mod, with its reason. */
export interface TrackOutcome {
  landed: readonly TrackedMod[];
  refused: readonly ItemRefusal<string>[];
}

/** Compile's answer: each plugin compiled, with its diagnostics, or refused with its reason. */
export interface CompileOutcome {
  landed: readonly CompiledPlugin[];
  refused: readonly ItemRefusal<PluginAddress>[];
}

export type RecordCreateResponse = components['schemas']['RecordCreateResponse'];
export type GridPosition = components['schemas']['GridPosition'];
/** A record and the plugin holding it (ADR-0012). */
export type RecordAddress = components['schemas']['RecordAddress'];
/** Copy's mode Option (commands.md, Record, `copy`). */
export type CopyMode = components['schemas']['CopyMode'];
/** One record into one destination: the unit a copy lands or is refused by. A new record's copy
 *  that landed names the FormKey mEdit minted for it. */
export type CopyItem = Pick<components['schemas']['RecordCopyLanded'], 'record' | 'destination' | 'newFormKey'>;
/** A record and the destinations that hold any of its child records, at any depth. */
export type RecordChildHolders = components['schemas']['RecordChildHolders'];
export type ReferenceResult = components['schemas']['ReferenceResult'];
/** The record filter mEdit holds: its SQL and the name of the source it came from
 *  (plugins.md, Record filter). */
export type RecordFilter = components['schemas']['FilterRequest'];

/** target-architecture.d2's mEdit client (ADR-0002). */
export interface MEditClient {
  // Commands — the HTTP adapter's verbs by today's names, each answering applied-or-refusal;
  // `rebuildIndex` answers with its own outcome shape (RebuildIndexOutcome).
  createPlugin(plugin: PluginAddress, folder: string): Promise<PluginCreatedResponse | WriteRefused>;
  // Renames the plugin source and moves the last-compile ref, as working-tree changes with no
  // commit. Its file and its lines are the Instance adapter's.
  renameSource(plugin: PluginAddress, newName: string): Promise<{ renamed: true } | WriteRefused>;
  rebuildIndex(instanceRoot: string, gameRelease: string): Promise<RebuildIndexOutcome>;
  track(mods: readonly string[], options?: { onProgress?: (status: TrackStatus) => void }): Promise<TrackOutcome | WriteRefused>;
  createRecord(
    plugin: PluginAddress, recordType: string, into?: { container?: string; position?: GridPosition },
  ): Promise<RecordCreateResponse | WriteRefused>;
  // commands.md, A selection is one gesture, and each item lands on its own. A WriteRefused is the
  // call itself failing, with nothing deleted.
  deleteRecords(records: readonly RecordAddress[]): Promise<SelectionOutcome<RecordAddress> | WriteRefused>;
  // Each record into each destination is one item, landed or refused on its own. `replace` lets an
  // override copy over the one a destination already holds.
  copyRecords(
    records: readonly RecordAddress[], mode: CopyMode, destinations: readonly PluginAddress[], replace: boolean,
  ): Promise<SelectionOutcome<CopyItem> | WriteRefused>;
  // Each plugin's source is replaced from its bytes, or it is refused, on its own. A WriteRefused is
  // the call itself refused, with nothing written.
  decompile(plugins: readonly PluginAddress[]): Promise<SelectionOutcome<PluginAddress> | WriteRefused>;
  // commands.md, A selection is one gesture, and each item lands on its own. A WriteRefused is the
  // call itself refused, with nothing written.
  compile(plugins: readonly PluginAddress[]): Promise<CompileOutcome | WriteRefused>;
  // Today's field-edit write, grouped here per the ruling: "edit (today the repository's)".
  editRecord(formKey: string, plugin: PluginAddress, envelope: RecordEditEnvelope): Promise<RecordEditOutcome>;

  // Queries — the read verbs, by their current names, plus the filter facet (set filter, clear
  // filter, active filter).
  getPlugins(): Promise<PluginMetadata[]>;
  getDiagnoses(): Promise<PluginDiagnosisReport[]>;
  // Rejects while mEdit has not finished indexing: a plugin it has not opened would read as no dependant.
  getPluginDependants(plugin: PluginAddress): Promise<PluginDependants>;
  getRecordTypes(plugin: PluginAddress): Promise<PluginRecordTypeCount[]>;
  // The game's, not a plugin's: every plugin of the load order shares it.
  getCreatableRecordTypes(): Promise<CreatableRecordType[]>;
  getCreatablePluginExtensions(): Promise<string[]>;
  // `unfiltered` lists what the record filter hides too.
  getRecords(
    plugin: PluginAddress, type: string, offset: number, limit: number, options?: { unfiltered: boolean },
  ): Promise<RecordPage>;
  searchRecords(query: string, validTypes: string[]): Promise<RecordPage>;
  getRecordOwner(formKey: string): Promise<PluginAddress | undefined>;
  /** Every plugin that holds a copy of the record, its own included. */
  getRecordHolders(formKey: string): Promise<PluginAddress[]>;
  /** Which of the records have child records in their own plugin. */
  getRecordsWithChildren(records: readonly RecordAddress[]): Promise<RecordAddress[]>;
  /** For each record, the destinations that hold any of its child records. */
  getChildrenInDestinations(
    records: readonly RecordAddress[], destinations: readonly PluginAddress[],
  ): Promise<RecordChildHolders[]>;
  /** One record as every active plugin has it, untransformed (target-architecture.d2 `modbench_driving.editor`).
   *  Null: no active plugin holds it and no `text` gives it. With `text`, that plugin's column reads
   *  from it, outside the conflict states if inactive. */
  getComparison(formKey: string, text?: CopyText): Promise<CompareResult | null>;
  /** Several records side by side: one column per copy, in the order given, with no conflict
   *  state on any cell or row. Null is a copy no plugin holds and no `documentText` gives. */
  getRecordsComparison(copies: RecordCopy[]): Promise<CompareResult | null>;
  getReferences(formKey: string): Promise<ReferenceResult[]>;
  /** `text` is the current text of the document carrying the record; mEdit writes nothing. */
  getEditChanges(
    formKey: string, plugin: PluginAddress, envelope: RecordEditEnvelope, text: string,
  ): Promise<RecordEditChangesOutcome>;
  getWorldspaces(plugin: PluginAddress): Promise<WorldspaceSummary[]>;
  getWorldspaceBlocks(plugin: PluginAddress, worldspaceFormKey: string): Promise<WorldspaceBlocks>;
  getCellChildRecords(plugin: PluginAddress, cellFormKey: string): Promise<CellChildRecords>;
  getInteriorCells(plugin: PluginAddress): Promise<InteriorCellBlock[]>;
  getContainerChildren(plugin: PluginAddress, parentFormKey: string): Promise<ContainerChildSummary[]>;
  /** Null when mEdit took the filter, or the reason it did not. */
  setFilter(filter: RecordFilter): Promise<string | null>;
  /** Null when mEdit dropped the filter, or the reason it did not. */
  clearFilter(): Promise<string | null>;
  getActiveFilter(): Promise<RecordFilter | null>;

  /** A listener handed its kind's payload. A frame missing its kind's payload
   *  reaches no listener. */
  onNotification<K extends NotificationKind>(kind: K, listener: (payload: NotificationPayloads[K]) => void): () => void;

  // ADR-0013's snapshot.
  putLoadOrder(
    plugins: LoadOrderPluginInput[], active: PluginAddress[], loadedWithNoLine: PluginAddress[],
    gameDirectory: string, instanceRoot: string, gameRelease: string, options?: LoadOrderOptions,
  ): Promise<LoadOrderOutcome>;

  // The backend process: today's four values, read as a current value and observed through a
  // status-changed event.
  readonly status: BackendStatus;
  onStatusChanged(listener: (status: BackendStatus) => void): () => void;
  /** The notification stream opened again while `running`. The process behind the stream may
   *  be a restarted one, holding nothing sent before. */
  onReconnected(listener: () => void): () => void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export type {
  TrackStatus, PluginMetadata, PluginDiagnosisReport, WorkingTreeState,
  RecordSummary, WorldspaceSummary, WorldspaceBlocks, WorldspaceBlock, WorldspaceSubBlock,
  CellChildRecords, CellSummary, ChildRecordSummary, ContainerChildSummary, CompiledPlugin, CompileDiagnostic,
  LoadOrderStatus, LoadOrderRefusal, PluginLoadFailure, CompareResult, RecordCopy, CopyText,
};

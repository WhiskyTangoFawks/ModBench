import type { components } from '../wire/generated/api';
import {
  type CompiledPlugin, type CompileDiagnostic,
  type ChangedPlugin,
  type TrackStatus, type PluginMetadata, type PluginDiagnosisReport,
  type WorldspaceSummary, type WorldspaceBlocks, type WorldspaceBlock, type WorldspaceSubBlock,
  type CellChildRecords, type CellSummary,
  type ChildRecordSummary, type ContainerChildSummary, type RecordSummary, type LoadOrderStatus, type LoadOrderRefusal,
  type PluginLoadFailure, type CompareResult, type CompareRecordsResponse, type RecordCopy, type CopyText,
} from './apiClient';
import type { RecordEditEnvelope } from '../wire/messages';
import type { PluginAddress } from '../wire/pluginAddress';
import type { UnreadableSource } from '../wire/unreadableSource';
import type { ItemRefusal, SelectionOutcome } from '../ports/selectionOutcome';

/** What `getEditChanges` is handed, re-exported because its caller reaches the backend only through
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
  'plugin-source-unreadable', 'record-filter-cleared',
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
  'plugin-source-unreadable': { plugins: (PluginAddress & UnreadableSource)[] };
  'record-filter-cleared': components['schemas']['RecordFilterClearedNotification'];
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

// Restated rather than imported from Mod Management's own snapshot type: this module belongs
// to Editing, which imports nothing from Mod Management.
interface LoadOrderPluginInput {
  name: string;
  path: string;
  origin: string;
  provider: components['schemas']['PluginProviderRequest'];
  line: number | null;
  lineNamesIt: boolean;
}

/** ADR-0013's snapshot, with the PUT's keys. */
export interface LoadOrderSnapshot {
  readonly plugins: LoadOrderPluginInput[];
  readonly active: PluginAddress[];
  readonly loadedWithNoLine: PluginAddress[];
  readonly gameDirectory: string;
  readonly instanceRoot: string;
  readonly gameRelease: string;
}

/** `abandoned`: a newer snapshot replaced this one before it was sent, or mEdit went away
 *  mid-flight. `backendFailed`: mEdit did not come up to take it. `applied` carries the terminal
 *  status the Index reached, never read off the PUT alone. */
export type LoadOrderOutcome =
  | { outcome: 'applied'; status: LoadOrderProgress }
  | { outcome: 'failed'; message: string }
  | { outcome: 'abandoned' }
  | { outcome: 'backendFailed' };

/** What a launch of mEdit came to. `stopped`: a stop cut it short. `failed` carries the launch's
 *  own error when it threw. */
export type LaunchOutcome = { outcome: 'running' } | { outcome: 'stopped' } | { outcome: 'failed'; error?: string };

/** A document with changes VS Code holds unsaved, by absolute path. */
export interface UnsavedDocument { path: string; text: string }

/** What a gesture changes in plugin source, by absolute path: each move, then each deletion of a file or folder, then
 *  each document's text once moved. */
export type SourceChanges = Pick<components['schemas']['RecordEditChangesResponse'], 'moves' | 'deletions' | 'documents'>;

// What deleting one record changes in plugin source.
type RecordDeleteChanges = SourceChanges & { record: RecordAddress };

/** A delete's changes per record, in the order to make them, and the records mEdit refused. */
export interface DeleteChangesOutcome {
  applied: readonly RecordDeleteChanges[];
  refused: readonly ItemRefusal<RecordAddress>[];
}

/** The changes creating a record makes to plugin source, and the new record's FormKey. */
export type CreateChangesOutcome = SourceChanges & { formKey: string };

/** An edit's changes to plugin source, each move and then each document's text at its absolute path,
 *  or its refusal: `refusal` is the backend's name, `'Unknown'` this side's. An edit of the FormID
 *  sets `newFormKey`. */
export type RecordEditChangesOutcome =
  | ({ applied: true; newFormKey?: string } & SourceChanges)
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
/** What is wrong in a tracked active plugin's source, per plugin: each problem names the referring
 *  record and its source file relative to the mod folder. */
export type PluginProblems = components['schemas']['PluginProblems'];
export type PluginRecordTypeCount = components['schemas']['PluginRecordTypeCount'];
export type WorkingTreeStatesBeneath = components['schemas']['WorkingTreeStatesBeneath'];
export type RecordTypeChoice = components['schemas']['RecordTypeChoice'];
export type RenderedDocument = components['schemas']['RenderedDocument'];
export type CopyDocument = components['schemas']['CopyDocument'];
export type RecordPage = components['schemas']['RecordSummaryPagedResult'];
export type InteriorCellBlock = components['schemas']['InteriorCellBlock'];
export type InteriorCellSubBlock = components['schemas']['InteriorCellSubBlock'];

// apiClient.ts aliases the wire shapes its own module needs; these are the port's own, named
// here for the same reason (modbench/CLAUDE.md: the generated schema is the frontend type).
export type PluginCreatedResponse = components['schemas']['PluginCreatedResponse'];
export type { PluginAddress };

interface TrackedMod {
  mod: string;
  tracked: readonly PluginAddress[];
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

export type GridPosition = components['schemas']['GridPosition'];
/** A record and the plugin holding it (ADR-0012). */
export type RecordAddress = components['schemas']['RecordAddress'];
/** Copy's mode Option (commands.md, Record, `copy`). */
export type CopyMode = components['schemas']['CopyMode'];
/** What copying one record into one destination changes in plugin source. A copy as new names the FormKey
 *  mEdit minted for it. */
type CopyChanges = components['schemas']['RecordCopyChanges'];
/** One record into one destination: the unit a copy lands or is refused by. */
export type CopyItem = Pick<CopyChanges, 'record' | 'destination'>;

/** A copy's changes per record and destination, in the order to make them, and the items mEdit refused. */
export interface CopyChangesOutcome {
  applied: readonly CopyChanges[];
  refused: readonly ItemRefusal<CopyItem>[];
}
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
  // `unsaved` stands in for the files it names. A WriteRefused is the call failing or mEdit refusing. Nothing is written.
  getCreateChanges(
    plugin: PluginAddress, recordType: string, unsaved: readonly UnsavedDocument[],
    into?: { container?: string; position?: GridPosition },
  ): Promise<CreateChangesOutcome | WriteRefused>;
  // commands.md, A selection is one gesture, and each item lands on its own. `unsaved` stands in for the files
  // it names. A WriteRefused is the call itself failing. Nothing is written.
  getDeleteChanges(
    records: readonly RecordAddress[], unsaved: readonly UnsavedDocument[],
  ): Promise<DeleteChangesOutcome | WriteRefused>;
  // Each record into each destination is one item, changed or refused on its own. `replace` lets an
  // override copy over the one a destination already holds. `unsaved` stands in for the files it names.
  // A WriteRefused is the call itself failing. Nothing is written.
  getCopyChanges(
    records: readonly RecordAddress[], mode: CopyMode, destinations: readonly PluginAddress[], replace: boolean,
    unsaved: readonly UnsavedDocument[],
  ): Promise<CopyChangesOutcome | WriteRefused>;
  // Each plugin's source is replaced from its bytes, or it is refused, on its own. A WriteRefused is
  // the call itself refused, with nothing written.
  decompile(plugins: readonly PluginAddress[]): Promise<SelectionOutcome<PluginAddress> | WriteRefused>;
  // commands.md, A selection is one gesture, and each item lands on its own. A WriteRefused is the
  // call itself refused, with nothing written.
  compile(plugins: readonly PluginAddress[]): Promise<CompileOutcome | WriteRefused>;

  // Queries — the read verbs, by their current names, plus the filter facet (set filter, clear
  // filter, active filter).
  getPlugins(): Promise<PluginMetadata[]>;
  getDiagnoses(): Promise<PluginDiagnosisReport[]>;
  // Rejects while mEdit has not finished indexing: a plugin it has not opened would read as no dependant.
  getPluginDependants(plugin: PluginAddress): Promise<PluginDependants>;
  // Rejects while mEdit has not finished indexing: a plugin it has not reached would read as clean.
  getPluginProblems(): Promise<PluginProblems[]>;
  getRecordTypes(plugin: PluginAddress): Promise<PluginRecordTypeCount[]>;
  getWorkingTreeStatesBeneath(plugin: PluginAddress): Promise<WorkingTreeStatesBeneath>;
  // The game's, not a plugin's: every plugin of the load order shares it.
  getCreatableRecordTypes(): Promise<RecordTypeChoice[]>;
  /** The types the plugin's copy of a container record can hold, in name order. */
  getChildRecordTypes(plugin: PluginAddress, formKey: string): Promise<RecordTypeChoice[]>;
  getCreatablePluginExtensions(): Promise<string[]>;
  getRecords(plugin: PluginAddress, type: string, offset: number, limit: number): Promise<RecordPage>;
  /** Every active plugin's copies, or one plugin's. */
  searchRecords(query: string, validTypes: string[], plugin?: PluginAddress): Promise<RecordPage>;
  getRecordOwner(formKey: string): Promise<PluginAddress | undefined>;
  /** Every plugin that holds a copy of the record, its own included. */
  getRecordHolders(formKey: string): Promise<PluginAddress[]>;
  /** One record as every active plugin has it, untransformed (target-architecture.d2 `modbench_driving.editor`).
   *  Null: no active plugin holds it and no `text` gives it. With `text`, that plugin's column reads
   *  from it, outside the conflict states if inactive. */
  getComparison(formKey: string, text?: CopyText): Promise<CompareResult | null>;
  /** Several records side by side: one column per copy, in order, with no conflict state. With no
   *  `compare`, `missing` names each copy no plugin gave and why. */
  getRecordsComparison(copies: RecordCopy[]): Promise<CompareRecordsResponse>;
  getReferences(formKey: string): Promise<ReferenceResult[]>;
  /** The referrers of the active plugins and of the inactive tracked ones. */
  getReferencesInActiveOrTrackedPlugins(formKey: string): Promise<ReferenceResult[]>;
  /** Null: the plugin holds no such record. */
  getRenderedDocument(plugin: PluginAddress, formKey: string): Promise<RenderedDocument | null>;
  /** Null: the plugin holds no such record. `location` is the path of the copy's own file, of the file of the
   *  record carrying it, or the name of its rendered document, as `kind` says. */
  getCopyDocument(plugin: PluginAddress, formKey: string): Promise<CopyDocument | null>;
  /** The record whose own document the file at the absolute `path` is; null when mEdit answers the file holds
   *  no record. Rejects with mEdit's reason when it cannot read the file. */
  getRecordOfFile(path: string): Promise<RecordAddress | null>;
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

  /** The latest load-order status; undefined before the first, and again when a held status
   *  resets: mEdit has gone, or the stream has reopened onto a process that may be another. */
  readonly loadOrderStatus: LoadOrderStatus | undefined;
  /** Each status as it arrives, and undefined when a held status resets. */
  onLoadOrderStatus(listener: (status: LoadOrderStatus | undefined) => void): () => void;
  /** A reconcile settled: a ready status newer than the last settled one, even when its picture
   *  repeats the last, and a status whose failures differ from those held. A reset starts the
   *  versions over and tells nothing. */
  onLoadOrderSettled(listener: (status: LoadOrderStatus) => void): () => void;

  /** One snapshot is put at a time, and the newest lands. Answers `backendFailed` once mEdit is gone. */
  sendLoadOrder(snapshot: LoadOrderSnapshot): Promise<LoadOrderOutcome>;
  /** The newest snapshot's outcome, following a superseding one. Undefined when none was sent. */
  latestLoadOrder(): Promise<LoadOrderOutcome | undefined>;
  /** Each put of the newest snapshot that no send asked for: after a reconnect, since the process
   *  behind the stream may hold nothing sent before. */
  onLoadOrderResent(listener: (snapshot: LoadOrderSnapshot, outcome: LoadOrderOutcome) => void): () => void;

  // The backend process: today's four values, read as a current value and observed through a
  // status-changed event.
  readonly status: BackendStatus;
  onStatusChanged(listener: (status: BackendStatus) => void): () => void;
  /** The notification stream opened again while `running`. The process behind the stream may
   *  be a restarted one, holding nothing sent before. */
  onReconnected(listener: () => void): () => void;
  /** commands.md, No lifecycle gestures for mEdit: it starts with the extension. Never rejects;
   *  a launch that fails leaves mEdit stopped, and `onLaunch` hears why. */
  start(): Promise<void>;
  /** Each launch as it begins: plugins.md, States story 2, shows progress while mEdit starts. */
  onLaunch(listener: (launched: Promise<LaunchOutcome>) => void): () => void;
  /** mEdit exited outside a launch and not by `stop`. Nothing starts it again. */
  onExit(listener: () => void): () => void;
  /** Abandons the snapshot in flight, then takes mEdit down. */
  stop(): Promise<void>;
}

export type {
  TrackStatus, PluginMetadata, PluginDiagnosisReport,
  RecordSummary, WorldspaceSummary, WorldspaceBlocks, WorldspaceBlock, WorldspaceSubBlock,
  CellChildRecords, CellSummary, ChildRecordSummary, ContainerChildSummary, CompileDiagnostic,
  LoadOrderRefusal, PluginLoadFailure, CompareResult, CompareRecordsResponse,
};

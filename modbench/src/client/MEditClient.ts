import type { components } from '../wire/generated/api';
import {
  type CompileDiagnostic,
  type ChangedPlugin,
  type PluginMetadata, type PluginDiagnosisReport,
  type WorldspaceSummary, type WorldspaceBlocks, type WorldspaceBlock, type WorldspaceSubBlock,
  type CellChildRecords, type CellSummary,
  type ChildRecordSummary, type ContainerChildSummary, type RecordSummary, type LoadOrderStatus, type LoadOrderRefusal,
  type PluginLoadFailure, type CompareResult, type CompareRecordsAnswer, type CopyText,
} from './apiClient';
import type { RecordEditEnvelope } from '../wire/messages';
import type { PluginAddress } from '../wire/pluginAddress';
import type { UnreadableSource } from '../wire/unreadableSource';
import type { ReadFailed } from '../wire/readFailed';
import type { ModByFolder } from '../wire/modByFolder';
import type { ItemRefusal, SelectionOutcome } from '../ports/selectionOutcome';

export type { ModByFolder };

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
  /** The request never reached mEdit, so no answer of mEdit's says anything of its items. */
  readonly unreachable?: true;
}

/** `WriteRefused`'s one structural tag — a plain check, not `instanceof`, so a scripted client's
 *  plain object narrows the same way the real one does. On the port, so narrowing never drags
 *  the HTTP adapter into a caller's test. */
export function isRefused(result: unknown): result is WriteRefused {
  return typeof result === 'object' && result !== null && (result as { refused?: unknown }).refused === true;
}

const NOTIFICATION_KINDS = [
  'rows-changed', 'plugin-changed', 'load-order-status', 'decompile-and-commit-progress', 'restore-from-manifest-progress', 'external-change',
  'plugin-source-unreadable', 'record-filter-cleared',
] as const;

/** The kinds a client subscribes to, narrowed from the schema's honest `string` for a typed `onNotification` call
 *  — not a mirror of `NotificationEvent`, which keeps every field as the schema reports it. */
export type NotificationKind = typeof NOTIFICATION_KINDS[number];

/** Each kind's payload as `onNotification` hands it over: a transform of the flat wire
 *  `NotificationEvent`, carrying only the fields its kind uses. */
export interface NotificationPayloads {
  'load-order-status': LoadOrderStatus;
  'decompile-and-commit-progress': DecompileAndCommitProgress;
  'restore-from-manifest-progress': ModlistProgress;
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

/** ADR-0013's snapshot, with the PUT's keys. */
export type LoadOrderSnapshot = components['schemas']['LoadOrderRequest'];

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
export type SourceChanges = Pick<components['schemas']['EditRecordChanges'], 'moves' | 'deletions' | 'documents'>;

/** A delete's changes per record, in the order to make them, and the records mEdit refused. */
export interface DeleteChangesOutcome {
  applied: readonly components['schemas']['RecordDeleted'][];
  refused: readonly ItemRefusal<RecordAt>[];
}

/** The changes renaming a plugin's source makes, and the name its tree was filed under. */
export type RenameSourceChangesOutcome = components['schemas']['RenameSourceChanges'];

/** The changes creating a record makes to plugin source, and the new record's FormKey. */
export type CreateChangesOutcome = components['schemas']['CreateRecordChanges'];

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
export type PluginDependants = components['schemas']['PluginDependants'];

/** Whether mEdit's rows for a plugin are of the file now on disk, not yet, or its read failed with `reason` (ADR-0003, ADR-0019). */
export type PluginIndexedState = components['schemas']['PluginIndexedState'];
/** What is wrong in a compiled, active plugin's source, per plugin: each problem names the referring
 *  record and its source file relative to the mod's source folder. */
export type PluginProblems = components['schemas']['PluginProblems'];
export type PluginRecordTypeCount = components['schemas']['PluginRecordTypeCount'];
export type WorkingTreeStatesBeneath = components['schemas']['WorkingTreeStatesBeneath'];
export type RecordTypeChoice = components['schemas']['RecordTypeChoice'];
export type RenderedDocument = components['schemas']['RenderedDocument'];
export type CopyDocument = components['schemas']['CopyDocument'];
export type RecordPage = components['schemas']['RecordSummaryPagedResult'];
export type InteriorCellBlock = components['schemas']['InteriorCellBlock'];
export type InteriorCellSubBlock = components['schemas']['InteriorCellSubBlock'];

export type { PluginAddress };

type DecompiledAndCommittedMod = components['schemas']['DecompiledAndCommittedMod'];

/** Decompile and commit's answer: each mod landed with the plugins its commit holds, or refused, as a mod, with its reason. */
export interface DecompileAndCommitOutcome {
  landed: readonly DecompiledAndCommittedMod[];
  refused: readonly ItemRefusal<string>[];
}

/** A malformed plugin's diagnoses, each with the change that repairs it, and the hash of the bytes they came from. */
export type PluginRepairPreview = components['schemas']['PluginRepairPreview'];

/** A plugin to repair, by the hash its preview answered, and the source folder its mod's repository is made in when it
 *  has none. */
export type PluginToRepair = components['schemas']['PluginToRepairRequest'];

/** A mod to decompile and commit, with its installation files and the mod manager's own files in its folder (ADR-0013). */
export type DecompileAndCommitMod = components['schemas']['DecompileAndCommitModRequest'];

/** A mod to build: the source folder whose manifest names it, its folder and its installation files
 *  (ADR-0013). */
export type BuildMod = components['schemas']['BuildModRequest'];

/** The instance's facts every mod's build needs: the mod manager's exclusion mark, and the release's archive variants. */
export type BuildFacts = Omit<components['schemas']['BuildRequest'], 'mods'>;

// The generated mod, with each refusal as `ItemRefusal` and each unset flag absent: mEdit sends null and false.
type BuiltMod = Omit<components['schemas']['ModBuilt'], 'refused' | 'archivesRefused' | 'failure' | 'uncommitted' | 'unpushed'> & {
  refused: readonly ItemRefusal<PluginAddress>[];
  archivesRefused: readonly ItemRefusal<string>[];
  failure?: string;
  uncommitted?: true;
  unpushed?: true;
};

/** Why mEdit refused a mod's build (ADR-0019). */
export type BuildRefusalKind = components['schemas']['BuildRefusal'];

/** Build's answer: each mod built, with the plugins it compiled and refused, or refused with its reason, mEdit's kind
 *  of refusal, and the installation files its manifest names that the call did not hand. */
export interface BuildOutcome {
  landed: readonly BuiltMod[];
  refused: readonly (ItemRefusal<string> & { readonly refusal?: BuildRefusalKind; readonly installationFilesNotFound?: readonly ManifestInstallationFile[]; readonly gameFilesNotFound?: readonly string[] })[];
}

/** A step of a manifest: the VS Code task it runs, by label, and the arguments it hands the task. */
export type ManifestStep = components['schemas']['ManifestStep'];

/** Where a modlist gesture is: the gesture it is, the mod it works on, and how many mods it has done of how many. The
 *  mod is none once it ends. */
export type ModlistProgress = components['schemas']['ModlistProgress'];

/** A mod's progress through decompile and commit: its place in the selection and the step it is at. */
export type DecompileAndCommitProgress = ModlistProgress & { phase?: components['schemas']['DecompileAndCommitPhase'] | null };

/** An abort stops mEdit after the mod in hand, and the mods done stay done. */
export interface ModlistCallOptions<P = ModlistProgress> {
  readonly onProgress?: (progress: P) => void;
  readonly signal?: AbortSignal;
}

/** A mod to restore from its manifest: its folder and its installation files (ADR-0013). */
export type RestoreMod = components['schemas']['RestoreFromManifestModRequest'];

/** Each submodule cloned, by the folder git checked it out in, with why its branch was left elsewhere, and each not cloned,
 *  by that folder, with why. */
export type SubmodulesCloned = components['schemas']['CloneSubmodulesResult'];

/** The instance's facts restore from manifest needs: the stat cache's folder, the game folder with the game files handed so
 *  far, the mod manager's exclusion mark and the archives a build packs. */
export type RestoreFacts = Omit<components['schemas']['RestoreFromManifestRequest'], 'mods' | 'gesture'>;

/** A mod restore would destroy files in: each file whose bytes differ from what its package fixes, and each file no line
 *  names, by its path in the mod folder, or a version or page in its metadata. */
export type ModRestoreDestroys = components['schemas']['ModRestoreDestroys'];

/** What a manifest says of its mod's version and installation files. */
export type ManifestMetadata = components['schemas']['ModMetadata'];

/** Each mod restore from manifest would destroy files in, and each mod skipped because a file of it could not be read. */
export interface WhatRestoreDestroys {
  destroys: readonly ModRestoreDestroys[];
  refused: readonly ItemRefusal<string>[];
  /** What each manifest says of its mod's version and installation files. */
  manifests: readonly components['schemas']['ManifestMetadataResponse'][];
}

type RestoredMod = components['schemas']['ModRestored'];

/** An installation file as a manifest names it: by name, with its hash and its page on its host. */
export type ManifestInstallationFile = Pick<components['schemas']['InstallationFile'], 'name' | 'hash'> & { readonly page?: string };

/** A skipped mod lacking installation files, as its manifest names them, a submodule, by name, or game files, by their path in
 *  the mod folder, that the call did not hand. A call that hands them brings it back. */
export interface NotFound {
  mod: string;
  installationFiles: readonly ManifestInstallationFile[];
  gameFiles: readonly string[];
  submodule?: string;
}

/** Restore from manifest's answer: each mod restored or skipped with its reason, and each skipped mod that is `NotFound`. */
export interface RestoreOutcome {
  landed: readonly RestoredMod[];
  refused: readonly ItemRefusal<string>[];
  notFound: readonly NotFound[];
  /** Why mEdit refused the user's cancel. */
  cancelRefusal?: string;
}

export type GridPosition = components['schemas']['GridPosition'];
/** A record and the plugin holding it (ADR-0012). */
export type RecordAt = components['schemas']['RecordAt'];
/** Copy's mode Option (commands.md, Record, `copy`). */
export type CopyMode = components['schemas']['CopyMode'];
type CopyChanges = components['schemas']['RecordCopied'];
/** One record into one destination: the unit a copy lands or is refused by. */
export type CopyItem = Pick<CopyChanges, 'record' | 'destination'>;

/** A copy's changes per record and destination, in the order to make them, and the items mEdit refused. */
export interface CopyChangesOutcome {
  applied: readonly CopyChanges[];
  refused: readonly ItemRefusal<CopyItem>[];
}
export type NameQuery = components['schemas']['NameQuery'];
export type NamedObject = components['schemas']['NamedObject'];
export type ReferenceResult = components['schemas']['ReferenceResult'];
/** The record filter mEdit holds: its SQL and the name of the source it came from
 *  (plugins.md, Record filter). */
export type RecordFilter = components['schemas']['RecordFilter'];

/** A change to a source mod's manifest: the output folder's new name, and paths in the mod folder to exclude or include. */
export type SourceManifestChange = Omit<components['schemas']['SourceManifestRequest'], 'sourceFolder'>;

/** target-architecture.d2's mEdit client (ADR-0002). */
export interface MEditClient {
  // Commands — the HTTP adapter's verbs by today's names, each answering applied-or-refusal;
  // `rebuildIndex` answers with its own outcome shape (RebuildIndexOutcome).
  createPlugin(plugin: PluginAddress, folder: string, sourceFolder: string | undefined): Promise<PluginAddress | WriteRefused>;
  // The changes renaming the plugin source makes over the unsaved documents mEdit holds, and the name its tree is
  // filed under. A WriteRefused is the call failing or mEdit refusing. Nothing is written.
  getRenameSourceChanges(plugin: PluginAddress, newName: string): Promise<RenameSourceChangesOutcome | WriteRefused>;
  // Moves what Modbench last wrote, filed under `treeName`, to the plugin's new name, once the source rename is applied and saved.
  moveLastWritten(plugin: PluginAddress, treeName: string, newName: string): Promise<{ moved: true } | WriteRefused>;
  rebuildIndex(instanceRoot: string, gameRelease: string): Promise<RebuildIndexOutcome>;
  decompileAndCommit(mods: readonly DecompileAndCommitMod[], options?: { onProgress?: (status: DecompileAndCommitProgress) => void }): Promise<DecompileAndCommitOutcome | WriteRefused>;
  // Over the unsaved documents mEdit holds. A WriteRefused is the call failing or mEdit refusing. Nothing is written.
  getCreateChanges(
    plugin: PluginAddress, recordType: string,
    into?: { container?: string; position?: GridPosition },
  ): Promise<CreateChangesOutcome | WriteRefused>;
  // commands.md, A selection is one gesture, and each item lands on its own. Over the unsaved documents
  // mEdit holds. A WriteRefused is the call itself failing. Nothing is written.
  getDeleteChanges(
    records: readonly RecordAt[],
  ): Promise<DeleteChangesOutcome | WriteRefused>;
  // Each record into each destination is one item, changed or refused on its own. `replace` lets an override
  // copy over a held one. Over the unsaved documents mEdit holds. A WriteRefused is the call failing. Nothing is written.
  getCopyChanges(
    records: readonly RecordAt[], mode: CopyMode, destinations: readonly PluginAddress[], replace: boolean,
  ): Promise<CopyChangesOutcome | WriteRefused>;
  // Each plugin's source is replaced from its bytes, or it is refused, on its own. A WriteRefused is
  // the call itself refused, with nothing written.
  decompile(plugins: readonly PluginAddress[], force: boolean): Promise<SelectionOutcome<PluginAddress> | WriteRefused>;
  // Each plugin's repair preview, or why it has none. Nothing is written.
  repairPreviews(plugins: readonly PluginAddress[]): Promise<{ landed: readonly PluginRepairPreview[]; refused: readonly ItemRefusal<PluginAddress>[] } | WriteRefused>;
  // Each plugin's source is written as two commits, or refused on its own. `metadataFiles`: the mod manager's files,
  // a new repository leaves out. `force` waives every loss, `agreedDrops` only the dropped data.
  decompileAndRepair(
    plugins: readonly PluginToRepair[], metadataFiles: readonly string[], force: boolean, agreedDrops: boolean,
  ): Promise<SelectionOutcome<PluginAddress> | WriteRefused>;
  // Rename's and exclude's half in mEdit: the manifest in the repository in `sourceFolder`, written in its working tree.
  changeSourceManifest(sourceFolder: string, change: SourceManifestChange): Promise<{ changed: true } | WriteRefused>;
  // commands.md, A selection is one gesture, and each item lands on its own. A WriteRefused is the
  // call itself refused, with nothing written.
  build(mods: readonly BuildMod[], facts: BuildFacts): Promise<BuildOutcome | WriteRefused>;
  restoreFromManifest(mods: readonly RestoreMod[], facts: RestoreFacts, options?: ModlistCallOptions): Promise<RestoreOutcome | WriteRefused>;
  // modlist-repository.md, Restore from manifest, story 3: each submodule cloned at its pin, or named with why it was not.
  cloneSubmodules(submodules: readonly NonNullable<RestoreMod['submodule']>[]): Promise<SubmodulesCloned | WriteRefused>;

  // Queries — the read verbs, by their current names, plus the filter facet (set filter, clear
  // filter, active filter). A read answers its value, or a ReadFailed (ADR-0019).
  getPlugins(): Promise<PluginMetadata[] | ReadFailed>;
  getDiagnoses(): Promise<PluginDiagnosisReport[] | ReadFailed>;
  // Fails while mEdit has not finished indexing: a plugin it has not opened would read as no dependant.
  getPluginDependants(plugin: PluginAddress): Promise<PluginDependants | ReadFailed>;
  getPluginIndexing(plugin: PluginAddress): Promise<PluginIndexedState | ReadFailed>;
  // Fails while mEdit has not finished indexing: a plugin it has not reached would read as clean.
  getPluginProblems(): Promise<PluginProblems[] | ReadFailed>;
  getRecordTypes(plugin: PluginAddress): Promise<PluginRecordTypeCount[] | ReadFailed>;
  getWorkingTreeStatesBeneath(plugin: PluginAddress): Promise<WorkingTreeStatesBeneath | ReadFailed>;
  // The game's, not a plugin's: every plugin of the load order shares it.
  getCreatableRecordTypes(): Promise<RecordTypeChoice[] | ReadFailed>;
  /** The types the plugin's copy of a container record can hold, in name order. */
  getChildRecordTypes(plugin: PluginAddress, formKey: string): Promise<RecordTypeChoice[] | ReadFailed>;
  getCreatablePluginExtensions(): Promise<string[] | ReadFailed>;
  getRecords(plugin: PluginAddress, type: string, offset: number, limit: number): Promise<RecordPage | ReadFailed>;
  /** Every active plugin's copies, or one plugin's. */
  searchRecords(query: string, validTypes: string[], plugin?: PluginAddress): Promise<RecordPage | ReadFailed>;
  getRecordOwner(formKey: string): Promise<PluginAddress | undefined | ReadFailed>;
  /** Every plugin that holds a copy of the record, its own included. */
  getRecordHolders(formKey: string): Promise<PluginAddress[] | ReadFailed>;
  /** One record as every active plugin has it, untransformed (target-architecture.d2 `modbench_driving.editor`).
   *  Null: no active plugin holds it and no `text` gives it. With `text`, that plugin's column reads
   *  from it, outside the conflict states if inactive. */
  getComparison(formKey: string, text?: CopyText): Promise<CompareResult | null | ReadFailed>;
  /** Several records side by side: one column per copy, in order, with no conflict state; `documentText`
   *  spells a copy in place of its plugin's. With no `compare`, `missing` names each copy no plugin gave and why. */
  getRecordsComparison(copies: components['schemas']['RecordCopy'][]): Promise<CompareRecordsAnswer | ReadFailed>;
  /** What each name means, in order, or why one cannot be: mEdit's refusal names every name it could not resolve, with each
   *  match of an ambiguous one. A name with an origin names a plugin. */
  resolveNames(names: readonly NameQuery[]): Promise<NamedObject[] | ReadFailed>;
  /** Each mod restore from manifest would destroy files in, from the stat cache in `statCache`, before anything is written. */
  getWhatRestoreDestroys(mods: readonly ModByFolder[], statCache: string): Promise<WhatRestoreDestroys | ReadFailed>;
  /** The rows one SQL SELECT over the record index selects. A statement that is not a SELECT, or cannot run, fails with the database's reason. */
  selectRows(sql: string): Promise<unknown[] | ReadFailed>;
  getReferences(formKey: string): Promise<ReferenceResult[] | ReadFailed>;
  /** The referrers of the active plugins and of the inactive compiled ones. */
  getReferencesInActiveOrCompiledPlugins(formKey: string): Promise<ReferenceResult[] | ReadFailed>;
  /** Null: the plugin holds no such record. */
  getRenderedDocument(plugin: PluginAddress, formKey: string): Promise<RenderedDocument | null | ReadFailed>;
  /** Null: the plugin holds no such record. `location` is the path of the copy's own file, of the file of the
   *  record carrying it, or the name of its rendered document, as `kind` says. */
  getCopyDocument(plugin: PluginAddress, formKey: string): Promise<CopyDocument | null | ReadFailed>;
  /** The record whose own document the file at the absolute `path` is; null when mEdit answers the file holds
   *  no record. Fails with mEdit's reason when it cannot read the file. */
  getRecordOfFile(path: string): Promise<RecordAt | null | ReadFailed>;
  /** Over the unsaved documents mEdit holds. mEdit writes nothing. */
  getEditChanges(
    formKey: string, plugin: PluginAddress, envelope: RecordEditEnvelope,
  ): Promise<RecordEditChangesOutcome>;
  getWorldspaces(plugin: PluginAddress): Promise<WorldspaceSummary[] | ReadFailed>;
  getWorldspaceBlocks(plugin: PluginAddress, worldspaceFormKey: string): Promise<WorldspaceBlocks | ReadFailed>;
  getCellChildRecords(plugin: PluginAddress, cellFormKey: string): Promise<CellChildRecords | ReadFailed>;
  getInteriorCells(plugin: PluginAddress): Promise<InteriorCellBlock[] | ReadFailed>;
  getContainerChildren(plugin: PluginAddress, parentFormKey: string): Promise<ContainerChildSummary[] | ReadFailed>;
  /** Null when mEdit took the filter, or the reason it did not. */
  setFilter(filter: RecordFilter): Promise<string | null>;
  /** Null when mEdit dropped the filter, or the reason it did not. */
  clearFilter(): Promise<string | null>;
  getActiveFilter(): Promise<RecordFilter | null | ReadFailed>;

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

  /** Every plugin-source document VS Code holds unsaved, which mEdit reads in place of its file (ADR-0015).
   *  Put at once and in order while mEdit runs, and the newest again whenever the process may hold none. */
  handUnsavedDocuments(documents: readonly UnsavedDocument[]): void;
  /** Each put of the unsaved documents as it answers: undefined when mEdit took them, else why not. */
  onUnsavedHandOver(listener: (failure: ReadFailed | undefined) => void): () => void;

  // The backend process: today's four values, read as a current value and observed through a
  // status-changed event.
  readonly status: BackendStatus;
  onStatusChanged(listener: (status: BackendStatus) => void): () => void;
  /** The port this window's mEdit answers on, heard as soon as it is known and again if it changes. */
  onPort(listener: (port: number) => void): () => void;
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
  PluginMetadata, PluginDiagnosisReport,
  RecordSummary, WorldspaceSummary, WorldspaceBlocks, WorldspaceBlock, WorldspaceSubBlock,
  CellChildRecords, CellSummary, ChildRecordSummary, ContainerChildSummary, CompileDiagnostic,
  LoadOrderRefusal, PluginLoadFailure, CompareResult, CompareRecordsAnswer,
};

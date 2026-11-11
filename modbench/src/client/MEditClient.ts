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
import type { PluginAddress, SourceModIn } from '../wire/pluginAddress';

/** A SELECT whose rows passed the length its reader asked for, so the reader stopped reading them. */
export interface RowsOutgrew { readonly outgrew: true }

export type { SourceModIn };
import type { ReadFailed } from '../wire/readFailed';
import type { ArchivedCopy, FlaggedPluginFile, FlaggedPluginHashes } from '../wire/messages';
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
  'rows-changed', 'plugin-changed', 'load-order-status', 'version-in-git-progress', 'external-change',
  'record-filter-cleared',
] as const;

/** The kinds a client subscribes to, narrowed from the schema's honest `string` for a typed `onNotification` call
 *  — not a mirror of `NotificationEvent`, which keeps every field as the schema reports it. */
export type NotificationKind = typeof NOTIFICATION_KINDS[number];

/** Each kind's payload as `onNotification` hands it over: a transform of the flat wire
 *  `NotificationEvent`, carrying only the fields its kind uses. */
export interface NotificationPayloads {
  'load-order-status': LoadOrderStatus;
  'version-in-git-progress': VersionInGitProgress;
  'external-change': { origin: string; changedPlugins: ChangedPlugin[] };
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

/** An archive's files, by their paths in it, or none and why it cannot be read. */
export type ArchiveContents = components['schemas']['ArchiveContents'];

/** A document with changes VS Code holds unsaved, by absolute path. */
export interface UnsavedDocument { path: string; text: string }

/** What a gesture changes in plugin source, by absolute path: each move, then each deletion of a file or folder, then
 *  each document's text once moved. */
export type SourceChanges = Pick<components['schemas']['EditRecordChanges'], 'moves' | 'deletions' | 'documents'>;

/** A file's move, by its path. */
export type SourceMove = components['schemas']['SourceMove'];

/** A delete's changes per record, in the order to make them, and the records mEdit refused. */
export interface DeleteChangesOutcome {
  applied: readonly components['schemas']['RecordDeleted'][];
  refused: readonly ItemRefusal<RecordAt>[];
}

/** The changes renaming a plugin's source makes, and the name its tree was filed under. */
export type RenameSourceChangesOutcome = components['schemas']['RenameSourceChanges'];

/** Whether mod order resolves the plugin's file name to the copy renamed, and each file of its source folder a build
 *  reads by its name, relative to the folder. */
export type RenameSourceAsked = Pick<components['schemas']['RenameSourceChangesRequest'], 'namedByFileName' | 'sourceFiles'>;

/** The changes creating a record makes to plugin source, and the new record's FormKey. */
export type CreateChangesOutcome = components['schemas']['CreateRecordChanges'];

/** An edit's changes to plugin source, or its refusal: `refusal` is the backend's name, `'Unknown'`
 *  this side's. An edit of the FormID sets `newFormKey`. */
export type RecordEditChangesOutcome =
  | ({ applied: true; newFormKey?: string } & Pick<components['schemas']['EditRecordChanges'], 'plugins' | 'leftBehind' | 'copiesLeftBehind' | 'copiesUnread'> & SourceChanges)
  | { applied: false; refusal: string; message: string };

/** `rebuildIndex`'s own outcome (ADR-0010). */
export type RebuildIndexOutcome =
  | { rebuilt: true }
  | { rebuilt: false; heldElsewhere: true }
  | { rebuilt: false; heldElsewhere: false; detail: string };

/** `/records` takes a plain `int` limit with no upper bound, so Int32.MaxValue lists every record
 *  of a group in one page. */
export const UNLIMITED_RECORDS = 2147483647;

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

type VersionedMod = components['schemas']['VersionedMod'];

/** Version in git's answer: each mod landed with the plugins its commit holds, or refused, as a mod, with its reason. */
export interface VersionInGitOutcome {
  landed: readonly VersionedMod[];
  refused: readonly ItemRefusal<string>[];
}

/** A plugin to repair, and the source folder made for its mod when the mod is not a source mod. */
export type PluginToRepair = components['schemas']['PluginToRepairRequest'];

/** A mod to version in git, and the source folder made for it: its assets and its manifest, as the extension hands them (ADR-0016). */
export type ModToVersionInGit = components['schemas']['ModToVersionInGitRequest'];

/** The source folder made for a mod, the repository that holds it, its assets by path in the mod folder, and its manifest. */
export type SourceFolderRequest = components['schemas']['SourceFolderRequest'];

/** A mod to build, as the extension hands it (ADR-0016): the paths it excludes, and the built-in step of its build file to run. */
export type BuildMod = components['schemas']['BuildModRequest'];

/** The instance's facts every mod's build needs: the mod manager's exclusion mark, and the release's archive variants. */
export type BuildFacts = Omit<components['schemas']['BuildRequest'], 'mods'>;

// The generated mod, with each refusal as `ItemRefusal` and each unset flag absent: mEdit sends null and false.
type BuiltMod = Omit<components['schemas']['ModBuilt'], 'refused' | 'archivesRefused' | 'failure' | 'uncommitted' | 'unpushed' | 'packed' | 'replaced' | 'ignored'> & {
  refused: readonly ItemRefusal<PluginAddress>[];
  archivesRefused: readonly (ItemRefusal<string> & { readonly unpacking?: true })[];
  packed?: readonly string[];
  replaced?: readonly components['schemas']['ReplacedTree'][];
  ignored?: readonly string[];
  failure?: string;
  uncommitted?: true;
  unpushed?: true;
};

/** Build's answer: each mod built, with the plugins it compiled and refused and each file it made, or refused with its
 *  reason. */
export interface BuildOutcome {
  landed: readonly BuiltMod[];
  refused: readonly ItemRefusal<string>[];
}

// Where a modlist gesture is: the mod it works on, none once it ends, and how many mods it has done of how many.
type ModlistProgress = components['schemas']['ModlistProgress'];

/** A mod's progress through version in git: its place in the selection and the step it is at. */
export type VersionInGitProgress = ModlistProgress & { phase?: components['schemas']['VersionInGitPhase'] | null };

/** A source mod's repository as the instance repository pins it: the folder git checks it out in, the pin and its branch. */
export type Submodule = components['schemas']['SubmoduleRequest'];

/** Each submodule cloned, by the folder git checked it out in, with why its branch was left elsewhere, and each not cloned,
 *  by that folder, with why. */
export type SubmodulesCloned = components['schemas']['CloneSubmodulesResult'];

/** Each plugin file whose load flags were set, with the hash of what was written, and each not set, by its path. */
export type PluginFilesFlagged = components['schemas']['SetPluginFileFlagsResult'];

/** A plugin file, by its absolute path, with each load flag to set (true) or clear (false). */
export type PluginFileToFlag = components['schemas']['PluginFileFlagsToSet'];


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

/** target-architecture.d2's mEdit client (ADR-0002). */
export interface MEditClient {
  // Commands — the HTTP adapter's verbs by today's names, each answering applied-or-refusal;
  // `rebuildIndex` answers with its own outcome shape (RebuildIndexOutcome).
  createPlugin(
    plugin: PluginAddress, folder: string, sourceFolder: string | undefined, flags: readonly string[] | undefined,
  ): Promise<PluginAddress | WriteRefused>;
  // The changes renaming the plugin source makes over the unsaved documents mEdit holds, and the name its tree is
  // filed under. A WriteRefused is the call failing or mEdit refusing. Nothing is written.
  getRenameSourceChanges(plugin: PluginAddress, newName: string, asked: RenameSourceAsked): Promise<RenameSourceChangesOutcome | WriteRefused>;
  // Moves what Modbench last wrote, filed under `treeName`, to the plugin's new name, once the source rename is applied and saved.
  moveLastWritten(plugin: PluginAddress, treeName: string, newName: string): Promise<{ moved: true } | WriteRefused>;
  // The source folder's move to `movedTo`, then each of `files` it holds, relative to it, as a rename of its mod moves them. Nothing is written.
  getSourceFolderMoveChanges(sourceFolder: string, movedTo: string, files: readonly SourceMove[]): Promise<SourceChanges | WriteRefused>;
  // What git holds of the source folder follows it, once the move is applied.
  followSourceFolderMove(sourceFolder: string, movedTo: string): Promise<{ followed: true } | WriteRefused>;
  rebuildIndex(instanceRoot: string, gameRelease: string): Promise<RebuildIndexOutcome>;
  versionInGit(mods: readonly ModToVersionInGit[], options?: { onProgress?: (status: VersionInGitProgress) => void }): Promise<VersionInGitOutcome | WriteRefused>;
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
  // Each plugin's source is written as two commits, or refused on its own. `force` waives the working-tree changes it replaces.
  decompileAndRepair(
    plugins: readonly PluginToRepair[], force: boolean,
  ): Promise<SelectionOutcome<PluginAddress> | WriteRefused>;
  // commands.md, A selection is one gesture, and each item lands on its own. A WriteRefused is the
  // call itself refused, with nothing written.
  build(mods: readonly BuildMod[], facts: BuildFacts): Promise<BuildOutcome | WriteRefused>;
  // ADR-0022: each submodule cloned at its pin, or named with why it was not.
  cloneSubmodules(submodules: readonly Submodule[]): Promise<SubmodulesCloned | WriteRefused>;
  // ADR-0022: each file's load flags set or cleared in place, no other byte changed.
  setPluginFileFlags(gameRelease: string, files: readonly PluginFileToFlag[]): Promise<PluginFilesFlagged | WriteRefused>;

  // Queries — the read verbs, by their current names, plus the filter facet (set filter, clear
  // filter, active filter). A read answers its value, or a ReadFailed (ADR-0019).
  getPlugins(): Promise<PluginMetadata[] | ReadFailed>;
  getDiagnoses(): Promise<PluginDiagnosisReport[] | ReadFailed>;
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
  /** The header flag combinations a new plugin of the file name's extension may take. */
  getCreatablePluginFlags(name: string): Promise<string[][] | ReadFailed>;
  /** What each archive holds, by its absolute path; the release says which game's format a BSA is read as. */
  getArchiveContents(gameRelease: string, archives: readonly string[]): Promise<ArchiveContents[] | ReadFailed>;
  /** The bytes of one file in an archive, by its path there. */
  getArchiveFile(gameRelease: string, archive: string, file: string): Promise<Uint8Array | ReadFailed>;
  /** Each of `files` the archive holds, by its path there, with its hash when `hashed`; one the archive does not hold is left out. */
  getArchiveCopies(gameRelease: string, archive: string, files: readonly string[], hashed: boolean): Promise<ArchivedCopy[] | ReadFailed>;
  /** Each plugin file's hashes with its flags at each combination of their original values, as a manifest carries them; writes nothing. */
  getFlaggedPluginHashes(gameRelease: string, files: readonly FlaggedPluginFile[]): Promise<FlaggedPluginHashes[] | ReadFailed>;
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
  /** The rows one SQL SELECT over the record index selects, or `outgrew` once their JSON text passes `atMostChars`, where
   *  the read stops. A statement that is not a SELECT, or cannot run, fails with the database's reason. */
  selectRows(sql: string, atMostChars: number): Promise<unknown[] | RowsOutgrew | ReadFailed>;
  getReferences(formKey: string): Promise<ReferenceResult[] | ReadFailed>;
  /** The referrers of the active plugins and of the inactive compiled ones. */
  getReferencesInActiveOrCompiledPlugins(formKey: string): Promise<ReferenceResult[] | ReadFailed>;
  /** Each copy whose text names the plugin file `name`, and the Plugin Header of each plugin with no plugin source that lists it as a master. */
  getPluginNameReferences(name: string): Promise<components['schemas']['CopyNaming'][] | ReadFailed>;
  getScriptReferences(name: string): Promise<components['schemas']['ScriptReferences'] | ReadFailed>;
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
  /** Tells mEdit the files at `paths` changed, or, with none, to check the disk (ADR-0015), once every snapshot handed
   *  before has answered. Signals handed while one is in flight fold into one more. */
  signalChange(paths: readonly string[]): void;
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

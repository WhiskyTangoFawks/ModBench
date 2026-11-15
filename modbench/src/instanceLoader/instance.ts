import { AsyncLocalStorage } from 'node:async_hooks';
import type { Log } from '../ports/log';
import { FileConflictLookup, NO_GAME_FOLDER_ARCHIVED, type GameFolderArchived, type FileWinners, type StackedCopies } from './fileConflictIndex';
import {
  listedArchivesNothingHolds, type ArchiveSources, type DataFolderFiles, type DataFolderPlugins, type LoadOrderPlugin, type LoadOrderPluginLine, type LoadOrderSnapshotRefusal,
  type LoadOrderSnapshotValue, type PluginWithNoLine,
} from './loadOrderSnapshot';
import { type LocatedDownloadedFileRow } from './downloadedFileRows';
import { nexusDomainForMetaGame } from '../tables/gamePaths';
import {
  ABSENT_SORTING_RULE_FILES, type InstanceReading, type GameFolder, type InstanceAdapter, type ModFolder,
  type ProgramVersion, type ProgramVersions, type EntryRef, type ManagerNames, type ManagerRunning, type ModGroups, type ModlistEntry, type OriginFile, type OriginFolder, type PublisherConfiguration,
  type PublisherTag, type Reread, type SortingRuleFiles, type Subscription, type UnwatchedFolder,
} from '../instanceAdapter/instanceAdapter';
import type { FlaggedRead, SourceMods } from '../manifestAdapter/manifestAdapter';
import { type PapyrusScript } from './papyrusScripts';
import { errorMessage } from '../ports/errorMessage';
import type { MEditClient } from '../client/MEditClient';
import type { Disposable } from '../client/eventEmitter';
import { FlaggedHashesHeld } from './flaggedHashes';
import { ArchiveContentsHeld, unreadableArchiveLines, type ArchiveRead } from './archiveContents';
import { FactsOfReading } from './factsOfReading';
import { WrittenFiles } from './writtenFiles';
import { collectingWrites } from './ambientWrites';

/** The rows this value is made of. A view names a row's shape through the read model that
 *  publishes it, never through the codec that parsed the file behind it. */
export { sameEntry } from '../instanceAdapter/instanceAdapter';
export type { EntryRef, FileOrigin, Mod, ModGroup, ModGroups, OriginFile, OriginFolder, PluginEntry, Separator } from '../instanceAdapter/instanceAdapter';
export type { LocatedDownloadedFileRow, DownloadedFileRow, UpgradeCandidate, UpgradeTier } from './downloadedFileRows';
export type { PapyrusScript } from './papyrusScripts';
export type { Covering, DownloadedFileStatus, PublisherTag, PublisherTagChange, TagPathProblem } from '../instanceAdapter/instanceAdapter';
export type { GameFolder, ProgramVersion, Reread } from '../instanceAdapter/instanceAdapter';

// How long another tool's write takes to settle: the wait a burst coalesces into one re-read on.
const SETTLE_MS = 200;

interface Run {
  readonly named: Set<string>;
  disk: boolean;
  /** The check was the watch's, so a change it finds is one no event named; a refresh's finds its caller's own write. */
  tellsUnheard: boolean;
  fromEvents: boolean;
  readonly settled: Promise<void>;
  /** Settles when the read has landed, before its subscribers have settled; rejects with the failure of a read that failed. A run dropped
   *  for a write in flight settles with the run that reads what it was to read. */
  readonly valueLanded: Promise<void>;
  readonly inherited: Run[];
  /** The named paths the read found as the value held them. */
  unchanged: ReadonlySet<string>;
  landValue(failure?: Error): void;
  land(settled: Promise<void>): void;
}

function nextRun(): Run {
  let land!: (settled: Promise<void>) => void;
  let settleValueLanded!: (failure?: Error) => void;
  const settled = new Promise<void>((resolve) => { land = resolve; });
  const valueLanded = new Promise<void>((resolve, reject) => { settleValueLanded = (failure) => { if (failure === undefined) resolve(); else reject(failure); }; });
  // A refresh asks for `settled` alone, so a failure nobody asked `valueLanded` for is not an unhandled one.
  valueLanded.catch(() => undefined);
  const inherited: Run[] = [];
  const landValue = (failure?: Error): void => {
    settleValueLanded(failure);
    for (const run of inherited) run.landValue(failure);
  };
  return { named: new Set(), disk: false, tellsUnheard: false, fromEvents: false, settled, valueLanded, inherited, unchanged: new Set(), landValue, land };
}

type NoteKind = 'notes' | 'links' | 'archiveListNotes' | 'orderNotes' | 'dataFolder' | 'dataFolderFiles' | 'gameArchives' | 'archives' | 'archiveContents' | 'listingNotes' | 'managerRunning' | 'publisherConfiguration' | 'programVersions';

type DownloadedFilesResult =
  | { readonly kind: 'listed'; readonly rows: readonly LocatedDownloadedFileRow[] }
  | { readonly kind: 'unresolved'; readonly reason: string };

export interface InstancePaths {
  /** `undefined` until read, and when the instance gives run-time output no folder. */
  readonly overwriteDir: string | undefined;
  /** `undefined` while unresolved (or not yet read): a consumer skips the action, no fallback. */
  readonly downloadsDir: string | undefined;
  /** Each listed mod's own folder, by mod name; a mod with no folder has none. */
  readonly modDirs: ReadonlyMap<string, string>;
  /** Each source mod's source folder, by mod name: the repository its manifest names, listed in the mod order or not. */
  readonly sourceDirs: ReadonlyMap<string, string>;
}

/** One generation of the instance, whole. Every field comes from the same read of disk, so a
 *  consumer holding one can never hold two facts from two generations. */
export interface InstanceValue {
  /** Mods and separators in Mod override order, winning-first, with `enabled`. */
  readonly mods: readonly ModlistEntry[];
  /** The same mod order grouped by separator, as the adapter groups it. */
  readonly modGroups: ModGroups;
  /** Every mod folder as the entry it holds, listed or not: what mod sync compares mod order
   *  with, and the new-empty-mod refusal's own input. Undefined when there is none to list. */
  readonly modFolders: readonly ModFolder[] | undefined;
  /** The mod manager's name for the folder of each mod order entry that has one (`modNameOf`). */
  readonly modNames: ReadonlyMap<string, string>;
  /** The source mods the mod order lists (ADR-0007). */
  readonly listedSourceMods: ReadonlySet<string>;
  /** Every mod a repository in the source folder builds, listed in the mod order or not. */
  readonly sourceMods: ReadonlySet<string>;
  /** Whether the instance folder holds a repository. */
  readonly holdsRepository: boolean;
  /** Whether git init has set the repository up. */
  readonly repositorySetUp: boolean;
  /** Every profile, the switch's choices. */
  readonly profiles: readonly string[];
  /** The winning enabled provider of every relative path, and its contenders. */
  readonly files: FileWinners;
  /** Each listed mod's own files, a disabled mod's too. */
  readonly filesByMod: ReadonlyMap<string, readonly OriginFile[]>;
  /** Each listed mod's folders, a disabled mod's too. */
  readonly foldersByMod: ReadonlyMap<string, readonly OriginFolder[]>;
  /** What each archive at the root of a listed mod or Overwrite holds, by the path it is read from. */
  readonly archiveContents: ReadonlyMap<string, ArchiveRead>;
  /** What mEdit says each plugin file a listed mod's manifest flags could have held before the flags, by the path it is read from. */
  readonly flaggedHashes: ReadonlyMap<string, FlaggedRead>;
  /** Whether the game loads the archive of this name at the root of its Data folder. */
  readonly loadsArchive: (name: string) => boolean;
  /** Each file an enabled mod or Overwrite provides, loose or in an archive the game loads, with its copies as the game
   *  stacks them: what a file order conflict is read from. */
  readonly stackedCopies: StackedCopies;
  /** The game folder's archives, read while the game folder is in the workspace: for symbol resolution, never for a conflict. */
  readonly gameFolderArchived: GameFolderArchived;
  /** Whether the workspace holds the game folder's Data folder: its archives are read, and its files are definitions, only then. */
  readonly gameFolderInWorkspace: boolean;
  /** Each Papyrus script an enabled mod, Overwrite or the Data folder holds (`papyrusScriptsOf`). */
  readonly papyrusScripts: readonly PapyrusScript[];
  /** Every plugin file, with origin, line, enabled and winning. A listed
   *  name neither a mod nor overwrite/ provides is still a row — a line-only one, `path`
   *  undefined — when the Data folder does not hold it or cannot be listed. */
  readonly plugins: readonly (LoadOrderPlugin | LoadOrderPluginLine)[];
  /** The downloaded files' rows, their metadata folded in — status and excluded included; or the
   *  reason their folder could not be resolved. */
  readonly downloadedFiles: DownloadedFilesResult;
  /** The profile the mod manager's configuration selects. */
  readonly activeProfile: string;
  /** How a message names the mod manager and its mod-order file: the adapter's answer, before any
   *  read too. */
  readonly managerNames: ManagerNames;
  readonly managerRunning: ManagerRunning;
  /** How the mod manager matches an entry's name: the adapter's `entryKey`. */
  readonly entryKey: (entry: EntryRef) => string;
  /** The game as the mod manager's configuration names it. */
  readonly gameName: string;
  /** The game loads a blueprint plugin after every plugin that is not one. */
  readonly blueprintLoadsLast: boolean;
  /** The Nexus domain of a game as a mod's or a downloaded file's metadata names it, so a view linking to a mod page holds no
   *  game table; undefined when the tables hold none. */
  readonly nexusDomainOf: (game: string) => string | undefined;
  /** The setting, then the mod manager's configuration, then detection; or each place looked when
   *  none answered. */
  readonly gameFolder: GameFolder;
  readonly programVersions: ProgramVersions;
  /** How many links the listings of the game folder ignored. */
  readonly gameFolderLinks: number;
  /** What the game's Data folder holds at its root — presence, never provision — or the reason
   *  it could not be read. */
  readonly dataFolderPlugins: DataFolderPlugins;
  /** Every file the game's Data folder holds, at any depth: presence, never provision. */
  readonly dataFolderFiles: DataFolderFiles;
  /** The plugins the game loads with no line, in the order it loads them; undefined while the
   *  game folder's plugins cannot be listed. */
  readonly pluginsLoadedWithNoLine: readonly PluginWithNoLine[] | undefined;
  /** ADR-0013's snapshot; undefined while the game folder is not found or its plugins cannot be
   *  listed, so nothing silently wrong is sent. */
  readonly loadOrderSnapshot: LoadOrderSnapshotValue | LoadOrderSnapshotRefusal | undefined;
  /** Overwrite's own files, recursive; none when the folder is absent or empty. */
  readonly overwriteFiles: readonly OriginFile[];
  /** Overwrite's folders, as `overwriteFiles` holds its files. */
  readonly overwriteFolders: readonly OriginFolder[];
  /** The paths this generation's rows name. */
  readonly paths: InstancePaths;
  /** Each publisher tag the instance's publisher declares: the adapter's answer, before any read too. */
  readonly publisherTags: readonly PublisherTag[];
  readonly publisherConfiguration: PublisherConfiguration;
  /** LOOT's metadata files, as the instance holds them. */
  readonly sortingRuleFiles: SortingRuleFiles;
  /** Each folder whose watch failed: a change in it shows only after a refresh. */
  readonly unwatchedFolders: readonly UnwatchedFolder[];
}

/** A subscriber that returns a promise holds `refresh` until it settles. `reread` is what the value was read again for. */
export type InstanceSubscriber<K extends keyof InstanceValue = keyof InstanceValue> = (value: Pick<InstanceValue, K>, sequence: number, reread: Reread) => void | Promise<void>;

/** The facts a subscriber reads, each named as a key. */
export type Concerns<K extends keyof InstanceValue> = Readonly<Record<K, true>>;

interface Subscribed {
  readonly subscriber: InstanceSubscriber;
  readonly concerns: readonly (keyof InstanceValue)[] | undefined;
}

const isFactOf = (value: InstanceValue) => (key: string): key is keyof InstanceValue => key in value;

/** Hears each recompute that failed; `readFailure` holds the reason. The value and sequence are
 *  where they were: before the first landed value that is the empty sentinel at 0. */
export type ReadFailureListener = () => void;
/** What calling one subscriber (`during` a landed value) or one read-failure listener (`during` a
 *  failed read) came to: `threw` is its error's message, undefined when it returned. */
export interface ListenerOutcome {
  readonly listener: object;
  readonly during: 'value' | 'read-failure';
  readonly threw: string | undefined;
}
export type ListenerOutcomeListener = (outcome: ListenerOutcome) => void;

/** The Instance as a tree reads it: the held value, sequence and read failure, plus the
 *  channels they move on. */
export type InstanceView = Pick<Instance, 'value' | 'sequence' | 'readFailure' | 'subscribe' | 'onReadFailure' | 'onRedraw'>;

/** The Instance as a subscriber that reads the facts `K` sees it. */
export type InstanceOf<K extends keyof InstanceValue> = Omit<InstanceView, 'value'> & { readonly value: Pick<InstanceValue, K> };

/** The facts the message line reads (`instanceMessages`). */
export const MESSAGE_READS = { managerRunning: true, managerNames: true } as const;

const cannotTellRunning = (manager: string, reason: string): string => `Cannot tell whether ${manager} is running: ${reason}.`;

function programVersionFailure(label: string, version: ProgramVersion): string[] {
  switch (version.kind) {
    case 'read': case 'notFound': return [];
    case 'noVersionResource': return [`[instance] ${label}: ${version.program} has no version resource`];
    case 'notAProgram': return [`[instance] ${label}: ${version.program} is not a Windows program`];
    case 'unreadable': return [`[instance] ${label}: ${version.program} cannot be read: ${version.why}`];
  }
}

// A missing extender loader is an answer, never a failure; a missing game program is one.
function programVersionFailures(versions: ProgramVersions): string[] {
  if (versions.kind !== 'found') return [];
  const game = versions.game.kind === 'notFound'
    ? [`[instance] the game's version: ${versions.game.program} is not in the game folder`]
    : programVersionFailure('the game\'s version', versions.game);
  return [...game, ...programVersionFailure('the script extender\'s version', versions.extender)];
}

export function managerRunningMessage({ managerRunning, managerNames: { manager } }: Pick<InstanceValue, keyof typeof MESSAGE_READS>): string | undefined {
  if (managerRunning.kind === 'unknown') return cannotTellRunning(manager, managerRunning.reason);
  return managerRunning.kind === 'running' ? `${manager} is running, and overwrites your changes when it launches a program or exits.` : undefined;
}

/** The instance's read failure once rows have landed, the reason of story 6's line. */
export function instanceLastGoodReadFailure({ sequence, readFailure }: Pick<InstanceView, 'sequence' | 'readFailure'>): string | undefined {
  return sequence > 0 ? readFailure : undefined;
}

/** What every view of the instance says on its message line (common.md, States), in order: the mod manager running
 *  (story 8), and a read that failed after rows landed (story 6), the error row's business before then. */
export function instanceMessages(view: Pick<InstanceOf<keyof typeof MESSAGE_READS>, 'value' | 'sequence' | 'readFailure'>): (string | undefined)[] {
  const reason = instanceLastGoodReadFailure(view);
  return [managerRunningMessage(view.value), reason === undefined ? undefined : `Showing the last good read: ${reason}`];
}

interface Workspace {
  holds(path: string): boolean;
  onDidChange(listener: () => void): Subscription;
}

interface InstanceOptions {
  /** The one reader of the instance; each recompute reads its settings once. */
  adapter: InstanceAdapter;
  /** The id of the setting that names the game folder, for a game folder not yet read. */
  gameFolderSettingId: string;
  workspace: Workspace;
  log: Log;
  medit: Pick<MEditClient, 'getArchiveContents' | 'getFlaggedPluginHashes' | 'onDidChange'>;
}

const emptyValue = (adapter: Pick<InstanceAdapter, 'names' | 'publisherTags'>, gameFolderSettingId: string, entryKey: InstanceValue['entryKey']): InstanceValue => ({
  mods: [],
  modGroups: { ungrouped: [], groups: [] },
  modFolders: [],
  modNames: new Map(),
  listedSourceMods: new Set(),
  sourceMods: new Set(),
  holdsRepository: false,
  repositorySetUp: false,
  profiles: [],
  files: new FileConflictLookup(),
  filesByMod: new Map(),
  foldersByMod: new Map(),
  archiveContents: new Map(),
  flaggedHashes: new Map(),
  loadsArchive: () => false,
  stackedCopies: new FileConflictLookup(),
  gameFolderArchived: NO_GAME_FOLDER_ARCHIVED,
  gameFolderInWorkspace: false,
  papyrusScripts: [],
  plugins: [],
  downloadedFiles: { kind: 'listed', rows: [] },
  activeProfile: '',
  managerNames: adapter.names,
  managerRunning: { kind: 'notRunning' },
  entryKey,
  gameName: '',
  blueprintLoadsLast: false,
  nexusDomainOf: nexusDomainForMetaGame,
  // Not read yet reads as not found, so a view that says not found waits for sequence 1.
  gameFolder: { kind: 'notFound', looked: [], setting: gameFolderSettingId },
  programVersions: { kind: 'unresolved' },
  gameFolderLinks: 0,
  dataFolderPlugins: { kind: 'unresolved' },
  dataFolderFiles: { kind: 'unresolved' },
  pluginsLoadedWithNoLine: undefined,
  loadOrderSnapshot: undefined,
  overwriteFiles: [],
  overwriteFolders: [],
  paths: { overwriteDir: undefined, downloadsDir: undefined, modDirs: new Map(), sourceDirs: new Map() },
  publisherTags: adapter.publisherTags,
  publisherConfiguration: { kind: 'none' },
  sortingRuleFiles: ABSENT_SORTING_RULE_FILES,
  unwatchedFolders: [],
});

export class Instance implements Subscription {
  private current: InstanceValue;

  private seq = 0;

  private failure: string | undefined;

  private subscribers: Subscribed[] = [];

  private failureListeners: ReadFailureListener[] = [];
  private redrawListeners: (() => void)[] = [];
  private lateListeners: (() => void)[] = [];
  private late = false;
  private outcomeListeners: ListenerOutcomeListener[] = [];

  private settleTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly heard = new Set<string>();

  private heardNoPath = false;

  // Recomputes never overlap, so a slow walk cannot publish over a newer one; what is asked during one folds into the next.
  private reading = false;

  private next: Run | undefined;
  private dropped: Run | undefined;

  private quiets = 0;

  private quietEpoch = 0;

  private readonly quietWork = new AsyncLocalStorage<WrittenFiles>();

  private readonly changes: Subscription;

  private readonly workspaceWatch: Subscription;

  private readonly archives: ArchiveContentsHeld;

  private readonly flagged: FlaggedHashesHeld;

  private readonly mEditChanges: Disposable;

  // A note is one Output line until its text changes or it clears.
  private readonly notesTold = new Map<NoteKind, ReadonlySet<string>>();
  private readonly facts: FactsOfReading;

  constructor(private readonly options: InstanceOptions) {
    const entryKey: InstanceValue['entryKey'] = (entry) => options.adapter.entryKey(entry);
    this.current = emptyValue(options.adapter, options.gameFolderSettingId, entryKey);
    this.changes = options.adapter.subscribe((path) => { this.hear(path); });
    this.workspaceWatch = options.workspace.onDidChange(() => {
      if (this.workspaceMovedFrom(this.current)) void this.enqueue({ disk: false, tellsUnheard: false });
    });
    this.archives = new ArchiveContentsHeld(options.medit);
    this.flagged = new FlaggedHashesHeld(options.medit);
    this.facts = new FactsOfReading(options.adapter, entryKey, this.archives, this.flagged);
    this.mEditChanges = options.medit.onDidChange((change) => {
      if (change === undefined && (this.archives.anyUnanswered || this.flagged.anyUnanswered)) void this.enqueue({ disk: false, tellsUnheard: false });
    });
  }

  /** Never undefined and never partial: before the first read it is the empty value at
   *  sequence 0. */
  get value(): InstanceValue {
    return this.current;
  }

  /** Rises once per landed recompute. A failed read leaves it where it was. */
  get sequence(): number {
    return this.seq;
  }

  /** Whether a load order is, or may yet be, handed to mEdit: the first read has not landed, or it found a snapshot to send. */
  get hasLoadOrderToHand(): boolean {
    const { loadOrderSnapshot } = this.value;
    return this.seq === 0 || (loadOrderSnapshot !== undefined && !('refusal' in loadOrderSnapshot));
  }

  /** The latest recompute's failure reason, undefined once a recompute lands. Held, not just
   *  fired, so a tree subscribing after the failure still hears it. */
  get readFailure(): string | undefined {
    return this.failure;
  }

  /** Called with each landed value and its sequence; with `concerns`, only with the first, the first after a failed read, a
   *  check of the disk, and each in which a concern is not the object it was. */
  subscribe<K extends keyof InstanceValue>(
    subscriber: InstanceSubscriber<K>, concerns?: Concerns<K>,
  ): Subscription {
    const subscribed: Subscribed = { subscriber, concerns: concerns && Object.keys(concerns).filter(isFactOf(this.current)) };
    this.subscribers.push(subscribed);
    return {
      dispose: () => {
        this.subscribers = this.subscribers.filter((s) => s !== subscribed);
      },
    };
  }

  /** Called on each failed recompute. A separate channel from `subscribe`, so a
   *  landed-value subscriber (the load-order PUT above all) never runs on a failure. */
  onReadFailure(listener: ReadFailureListener): Subscription {
    this.failureListeners.push(listener);
    return {
      dispose: () => {
        this.failureListeners = this.failureListeners.filter((l) => l !== listener);
      },
    };
  }

  /** Called on each `redraw`, by the views alone: a subscriber that derives from the value or hands it on does not run again. */
  onRedraw(listener: () => void): Subscription {
    this.redrawListeners.push(listener);
    return { dispose: () => { this.redrawListeners = this.redrawListeners.filter((l) => l !== listener); } };
  }

  /** Whether a change was heard that no read has taken in since. */
  get mayBeLate(): boolean {
    return this.late;
  }

  /** Called each time `mayBeLate` changes. */
  onMayBeLate(listener: () => void): Subscription {
    this.lateListeners.push(listener);
    return { dispose: () => { this.lateListeners = this.lateListeners.filter((l) => l !== listener); } };
  }

  /** Draws the held value again, with no read: a control the user toggled returns to what the value says. */
  redraw(): void {
    for (const listener of [...this.redrawListeners]) listener();
  }

  /** Called with the outcome of each call to a subscriber or read-failure listener, so a view that
   *  missed an update can be told of. */
  onListenerOutcome(listener: ListenerOutcomeListener): Subscription {
    this.outcomeListeners.push(listener);
    return {
      dispose: () => {
        this.outcomeListeners = this.outcomeListeners.filter((l) => l !== listener);
      },
    };
  }

  /** A read of the files `wrote` names, or a check of the disk when none is named. Settles when its read has run; a read
   *  that overlapped `quiet` is dropped, not landed. */
  refresh(wrote?: readonly string[]): Promise<void> {
    return this.enqueue({ named: wrote, disk: wrote === undefined, tellsUnheard: false });
  }

  /** Answers once the value holds the files a write just wrote, without waiting for the subscribers: a subscriber may be
   *  the writer's own caller, holding a lock the write took. No read lands inside `quiet`, which answers its own. */
  told(wrote: readonly string[]): Promise<void> {
    const work = this.quietWork.getStore();
    if (work !== undefined) {
      work.name(wrote);
      return Promise.resolve();
    }
    return this.enqueue({ named: wrote, disk: false, tellsUnheard: false }, 'valueLanded');
  }

  /** Runs `work`, a write to several files the value reads, then refreshes at the files `work` names. A read that overlapped
   *  it never lands: it may hold some files from before the write and some after. */
  async quiet<T>(work: (written: WrittenFiles) => Promise<T>): Promise<T> {
    const written = new WrittenFiles();
    this.quietEpoch++;
    this.quiets++;
    try {
      return await this.quietWork.run(written, () => collectingWrites(written, () => work(written)));
    } finally {
      this.quiets--;
      this.quietEpoch++;
      await this.refresh(written.named);
    }
  }

  /** The value once the first read has landed: reads when none has, and holds the read it has. */
  async landed(): Promise<InstanceValue> {
    if (this.seq === 0) await this.refresh();
    return this.value;
  }

  dispose(): void {
    clearTimeout(this.settleTimer);
    this.changes.dispose();
    this.workspaceWatch.dispose();
    this.mEditChanges.dispose();
    this.subscribers = [];
    this.failureListeners = [];
    this.redrawListeners = [];
    this.lateListeners = [];
    this.outcomeListeners = [];
  }

  private tellReading({
    linkNotes, archiveListNotes, orderNotes, modFiles, runtimeOutput, dataFolderPlugins, dataFolderFiles, dataFolderArchives, managerRunning,
    publisherConfiguration, programVersions,
  }: InstanceReading, sourceMods: SourceMods): void {
    const notes = [...runtimeOutput.notes.map((n) => `${runtimeOutput.origin}: ${n}`), ...sourceMods.notes];
    this.tellOnce('notes', notes.map((note) => `[instance] ${note}`), 'info');
    const listingNotes = [...modFiles].flatMap(([name, listing]) => listing.notes.map((note) => `[instance] ${name}: ${note}`));
    this.tellOnce('listingNotes', listingNotes, 'info');
    this.tellOnce('links', linkNotes.map((note) => `[instance] ${note}`), 'info');
    this.tellOnce('orderNotes', orderNotes.map((note) => `[instance] ${note}`), 'warn');
    this.tellOnce('archiveListNotes', archiveListNotes.map((note) => `[instance] ${note}`), 'warn');
    // An unreadable Data folder or its archives is an answer, never a failed read: the whole value
    // would otherwise go stale over a folder outside the instance.
    this.tellOnce('dataFolder', dataFolderPlugins.kind === 'unreadable' ? [`[instance] the game's Data folder could not be listed: ${dataFolderPlugins.reason}`] : [], 'warn');
    const filesAlone = dataFolderPlugins.kind !== 'unreadable' && dataFolderFiles.kind === 'unreadable';
    this.tellOnce('dataFolderFiles', filesAlone ? [`[instance] the game's Data folder could not be listed whole: ${dataFolderFiles.reason}`] : [], 'warn');
    const { manager } = this.options.adapter.names;
    this.tellOnce('managerRunning', managerRunning.kind === 'unknown' ? [`[instance] ${cannotTellRunning(manager, managerRunning.reason)}`] : [], 'warn');
    this.tellOnce('gameArchives', dataFolderArchives.kind === 'unreadable' ? [`[instance] the game's archives and strings files could not be listed: ${dataFolderArchives.reason}`] : [], 'warn');
    this.tellOnce('programVersions', programVersionFailures(programVersions), 'warn');
    this.tellOnce('publisherConfiguration', publisherConfiguration.kind === 'unreadable' ? [`[instance] no publisher tag shows: ${publisherConfiguration.reason}`] : [], 'warn');
  }

  private tellOnce(kind: NoteKind, lines: readonly string[], level: 'info' | 'warn'): void {
    const before = this.notesTold.get(kind);
    for (const line of lines) if (!before?.has(line)) this.options.log[level](line);
    this.notesTold.set(kind, new Set(lines));
  }

  // xEdit reports a listed archive it cannot find; the game loads none, so the views stay true.
  private tellArchivesNothingHolds(sources: ArchiveSources): void {
    const missing = listedArchivesNothingHolds(sources);
    this.tellOnce('archives', missing.map((name) => `[instance] The game's INIs list the archive ${name}, which no mod, Overwrite or game folder holds.`), 'info');
  }

  private hear(path: string | undefined): void {
    if (path === undefined) this.heardNoPath = true;
    else this.heard.add(path);
    this.setLate(true);
    clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      const named = [...this.heard];
      const disk = this.heardNoPath;
      this.heard.clear();
      this.heardNoPath = false;
      void this.enqueue({ named, disk, tellsUnheard: disk, fromEvents: true });
    }, SETTLE_MS);
  }

  private setLate(late: boolean): void {
    if (late === this.late) return;
    this.late = late;
    for (const listener of [...this.lateListeners]) listener();
  }

  private heardSinceRun(): boolean {
    return this.heard.size > 0 || this.heardNoPath || this.next?.fromEvents === true;
  }

  private enqueue({ named = [], disk, tellsUnheard, fromEvents = false }: {
    named?: readonly string[]; disk: boolean; tellsUnheard: boolean; fromEvents?: boolean;
  }, answers: 'settled' | 'valueLanded' = 'settled'): Promise<void> {
    const next = this.next ?? nextRun();
    this.next = next;
    if (this.dropped !== undefined) {
      for (const path of this.dropped.named) next.named.add(path);
      next.disk ||= this.dropped.disk;
      next.tellsUnheard ||= this.dropped.tellsUnheard;
      next.fromEvents ||= this.dropped.fromEvents;
      next.inherited.push(...this.dropped.inherited);
      this.dropped = undefined;
    }
    for (const path of named) next.named.add(path);
    next.fromEvents ||= fromEvents || (disk && (this.heard.size > 0 || this.heardNoPath));
    if (disk) {
      for (const path of this.heard) next.named.add(path);
      this.heard.clear();
      this.heardNoPath = false;
      clearTimeout(this.settleTimer);
    }
    next.disk ||= disk;
    next.tellsUnheard ||= tellsUnheard;
    void this.drain();
    return next[answers];
  }

  // A run settles with its value's subscribers; the next run does not wait for them.
  private async drain(): Promise<void> {
    if (this.reading) return;
    this.reading = true;
    for (let run = this.next; run !== undefined; run = this.next) {
      this.next = undefined;
      const { settled, failed, dropped } = await this.recompute(run);
      if (!dropped) run.landValue(failed);
      run.land(settled);
    }
    this.reading = false;
  }

  // A read that throws logs and leaves the last value and the last sequence in place, so a file
  // another tool is half-way through writing never empties the trees.
  private async recompute(run: Run): Promise<{ settled: Promise<void>; failed?: Error; dropped?: true }> {
    let next: InstanceValue;
    const epoch = this.quietEpoch;
    try {
      next = await this.read(run);
    } catch (err) {
      if (epoch !== this.quietEpoch || this.quiets > 0) return this.dropRun(run);
      this.setLate(this.heardSinceRun());
      const failure = errorMessage(err);
      this.options.log.error(`[instance] Failed to read the instance: ${failure}`);
      this.failure = failure;
      return { settled: this.notify(this.failureListeners, 'read-failure', (listener) => listener()), failed: new Error(failure) };
    }
    if (epoch !== this.quietEpoch || this.quiets > 0) return this.dropRun(run);
    const before = this.current;
    const tellsEvery = this.seq === 0 || this.failure !== undefined || run.disk;
    this.current = next;
    this.failure = undefined;
    this.setLate(this.heardSinceRun());
    this.seq++;
    const reread: Reread = { named: [...run.named].filter((path) => !run.unchanged.has(path)), disk: run.disk };
    if (this.workspaceMovedFrom(next)) void this.enqueue({ disk: false, tellsUnheard: false });
    const told = this.subscribers.filter(({ concerns }) => tellsEvery || concerns === undefined || concerns.some((fact) => next[fact] !== before[fact]));
    return { settled: this.notify(told.map(({ subscriber }) => subscriber), 'value', (subscriber) => subscriber(next, this.seq, reread)) };
  }

  // What a dropped run was to read is read by the next run, so a change the watch heard while a write ran is never lost.
  private dropRun(run: Run): { settled: Promise<void>; dropped: true } {
    const dropped = this.dropped ?? nextRun();
    this.dropped = dropped;
    for (const path of run.named) dropped.named.add(path);
    dropped.disk ||= run.disk;
    dropped.tellsUnheard ||= run.tellsUnheard;
    dropped.fromEvents ||= run.fromEvents;
    dropped.inherited.push(run);
    if (this.quiets === 0) void this.enqueue({ disk: false, tellsUnheard: false });
    return { settled: Promise.resolve(), dropped: true };
  }

  // A throwing subscriber would otherwise reject the queue for good, and no later recompute
  // would run — the dead chain tail every write queue's tail-catch documents.
  private async notify<T extends object>(listeners: readonly T[], during: ListenerOutcome['during'], call: (listener: T) => void | Promise<void>): Promise<void> {
    await Promise.all([...listeners].map(async (listener) => {
      let threw: string | undefined;
      try {
        await call(listener);
      } catch (err) {
        threw = errorMessage(err);
      }
      for (const onOutcome of [...this.outcomeListeners]) onOutcome({ listener, during, threw });
    }));
  }

  // A change heard while a read was under way is compared with the value it lands, not the one before it.
  private workspaceMovedFrom({ gameFolder, gameFolderInWorkspace }: InstanceValue): boolean {
    return (this.workspaceDataFolder(gameFolder) !== undefined) !== gameFolderInWorkspace;
  }

  private workspaceDataFolder(gameFolder: GameFolder): string | undefined {
    return gameFolder.kind === 'found' && this.options.workspace.holds(gameFolder.dataFolder) ? gameFolder.dataFolder : undefined;
  }

  private async read(run: Run): Promise<InstanceValue> {
    const { named, disk, tellsUnheard } = run;
    const { adapter, log } = this.options;
    const reading = await adapter.reading({ named: [...named], disk });
    if (tellsUnheard) for (const path of reading.unheardChanges) log.info(`[instance] The check of the disk found a change no event named: ${path}`);
    run.unchanged = new Set(reading.unchangedFiles);
    return this.facts.of(reading, this.workspaceDataFolder(reading.gameFolder), {
      sourceMods: (sourceMods) => { this.tellReading(reading, sourceMods); },
      archiveSources: (sources) => { this.tellArchivesNothingHolds(sources); },
      archiveContents: (reads) => { this.tellOnce('archiveContents', unreadableArchiveLines(reads), 'warn'); },
    });
  }

}

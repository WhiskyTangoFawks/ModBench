// The instance value (ADR-0015).

import type { Log } from '../ports/log';
import { buildFileConflictIndex, FileConflictLookup, type FileWinners } from './fileConflictIndex';
import {
  buildLoadOrderRows, listedArchivesNothingHolds, loadOrderSnapshotOf, OVERWRITE_ORIGIN, pluginsLoadedWithNoLineOf, stampedSnapshot, type ArchiveSources,
  type DataFolderPlugins, type LoadOrderPlugin, type LoadOrderPluginLine, type LoadOrderSnapshotRefusal,
  type LoadOrderSnapshotValue,
} from './loadOrderSnapshot';
import { withMetadataRead } from '../wire/modByFolder';
import { modNameOf, modNamesOf } from './modName';
import type { PluginAddress } from '../wire/pluginAddress';
import { present } from '../ports/present';
import { buildDownloadRows, modsByArchiveFilename, type DownloadFile } from './downloadRows';
import { loadedWithNoLineOf, nexusDomainForMetaGame } from '../tables/gamePaths';
import {
  GAME_FOLDER_SETTING, type DownloadedFiles, type InstanceReading, type GameFolder, type InstanceAdapter, type ModFolder, type ModFolders,
  type EntryRef, type ManagerNames, type ModGroups, type ModlistEntry, type OriginFile, type OriginFiles, type OriginFolder, type SourceMods, type Subscription,
} from '../instanceAdapter/instanceAdapter';
import { pluginPlacesOf } from './pluginPlacesOf';
import { sameCopies, type FileCopies } from './sameCopies';
import { errorMessage } from '../ports/errorMessage';

/** The rows this value is made of. A view names a row's shape through the read model that
 *  publishes it, never through the codec that parsed the file behind it. */
export type { EntryRef, FileOrigin, Mod, ModGroup, ModGroups, OriginFile, OriginFolder, PluginEntry, Separator } from '../instanceAdapter/instanceAdapter';
export type { DownloadFile, DownloadRow, UpgradeCandidate, UpgradeTier } from './downloadRows';
export type { Copy, FileCopies } from './sameCopies';
export type { DownloadStatus } from '../instanceAdapter/instanceAdapter';
export type { GameFolder } from '../instanceAdapter/instanceAdapter';

// How long another tool's write takes to settle: the wait a burst coalesces into one recompute on.
const SETTLE_MS = 200;

type NoteKind = 'notes' | 'links' | 'archiveListNotes' | 'orderNotes' | 'dataFolder' | 'gameArchives' | 'archives';

type DownloadsResult =
  | { readonly kind: 'listed'; readonly rows: readonly DownloadFile[] }
  | { readonly kind: 'unresolved'; readonly reason: string };

interface InstancePaths {
  /** `undefined` until read, and when the instance gives run-time output no folder. */
  readonly overwriteDir: string | undefined;
  /** `undefined` while unresolved (or not yet read): a consumer skips the action, no fallback. */
  readonly downloadsDir: string | undefined;
  /** Each listed mod's own folder, by mod name; a mod with no folder has none. */
  readonly modDirs: ReadonlyMap<string, string>;
  /** Each source mod's source folder, by mod name: the repository whose build configuration names it as its output,
   *  listed in the mod order or not. */
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
  /** The tracked mods (ADR-0007). */
  readonly trackedMods: ReadonlySet<string>;
  /** Every mod a repository in the source folder builds, listed in the mod order or not. */
  readonly sourceMods: ReadonlySet<string>;
  /** Whether the instance folder holds a repository. */
  readonly holdsRepository: boolean;
  /** Every profile, the switch's choices. */
  readonly profiles: readonly string[];
  /** The winning enabled provider of every relative path, and its contenders. */
  readonly files: FileWinners;
  /** Each listed mod's own files, a disabled mod's too. */
  readonly filesByMod: ReadonlyMap<string, readonly OriginFile[]>;
  /** Each listed mod's folders, a disabled mod's too. */
  readonly foldersByMod: ReadonlyMap<string, readonly OriginFolder[]>;
  /** Every plugin file, with origin, line, enabled and winning. A listed
   *  name neither a mod nor overwrite/ provides is still a row — a line-only one, `path`
   *  undefined — when the game folder is not found. */
  readonly plugins: readonly (LoadOrderPlugin | LoadOrderPluginLine)[];
  /** The downloaded files' rows, their metadata folded in — status and excluded included; or the
   *  reason their folder could not be resolved. */
  readonly downloads: DownloadsResult;
  /** The profile the mod manager's configuration selects. */
  readonly activeProfile: string;
  /** How a message names the mod manager and its mod-order file: the adapter's answer, before any
   *  read too. */
  readonly managerNames: ManagerNames;
  /** How the mod manager matches an entry's name: the adapter's `entryKey`. */
  readonly entryKey: (entry: EntryRef) => string;
  /** The game as the mod manager's configuration names it. */
  readonly gameName: string;
  /** Mutagen's release of that game; undefined when the tables hold none for it. */
  readonly gameRelease: string | undefined;
  /** The Nexus domain of a game as a mod's or a download's metadata names it, so a view linking to a mod page holds no
   *  game table; undefined when the tables hold none. */
  readonly nexusDomainOf: (game: string) => string | undefined;
  /** The setting, then the mod manager's configuration, then detection; or each place looked when
   *  none answered. */
  readonly gameFolder: GameFolder;
  /** What the game's Data folder holds at its root — presence, never provision — or the reason
   *  it could not be read. */
  readonly dataFolderPlugins: DataFolderPlugins;
  /** The plugins the game loads with no line, in the order it loads them; undefined while the
   *  game folder's plugins cannot be listed. */
  readonly pluginsLoadedWithNoLine: readonly PluginAddress[] | undefined;
  /** ADR-0013's snapshot; undefined while the game folder is not found or its plugins cannot be
   *  listed, so nothing silently wrong is sent. */
  readonly loadOrderSnapshot: LoadOrderSnapshotValue | LoadOrderSnapshotRefusal | undefined;
  /** Overwrite's own files, recursive; none when the folder is absent or empty. */
  readonly overwriteFiles: readonly OriginFile[];
  /** Overwrite's folders, as `overwriteFiles` holds its files. */
  readonly overwriteFolders: readonly OriginFolder[];
  /** The paths this generation's rows name. */
  readonly paths: InstancePaths;
}

export type InstanceSubscriber = (value: InstanceValue, sequence: number) => void;

/** Hears each recompute that failed; `readFailure` holds the reason. The value and sequence are
 *  where they were: before the first landed value that is the empty sentinel at 0. */
export type ReadFailureListener = () => void;

/** The Instance as a tree reads it: the held value, sequence and read failure, plus the two
 *  channels they move on. */
export type InstanceView = Pick<Instance, 'value' | 'sequence' | 'readFailure' | 'subscribe' | 'onReadFailure'>;

/** The message line a view shows once a read fails after rows landed: the rows stay (common.md,
 *  States, story 6). Before the first value it is the error row's business, not this. */
export function lastGoodReadMessage({ sequence, readFailure }: Pick<InstanceView, 'sequence' | 'readFailure'>): string | undefined {
  return sequence > 0 && readFailure !== undefined ? `Showing the last good read: ${readFailure}` : undefined;
}

interface FocusWindow {
  readonly state: { readonly focused: boolean };
  onDidChangeWindowState(listener: (state: { readonly focused: boolean }) => void): Subscription;
}

interface InstanceOptions {
  /** The one reader of the instance; each recompute reads its settings once. */
  adapter: InstanceAdapter;
  window: FocusWindow;
  log: Log;
}

// A listed source mod under its name in the mod order, an unlisted one under the output its repository names.
function sourceDirsOf(entries: readonly ModlistEntry[], sourceMods: SourceMods): Map<string, string> {
  const listed = entries.flatMap((entry) => {
    const folder = entry.kind === 'mod' ? sourceMods.folderOf(entry.name) : undefined;
    return folder === undefined ? [] : [[entry.name, folder] as const];
  });
  const claimed = new Set(listed.map(([, folder]) => folder));
  return new Map([...listed, ...[...sourceMods.folders].filter(([, folder]) => !claimed.has(folder))]);
}

// Each listed mod's folder is matched as the manager matches names.
function pathsOf(
  runtimeOutput: OriginFiles, downloaded: DownloadedFiles, entries: readonly ModlistEntry[], modFolders: ModFolders | undefined,
  sourceMods: SourceMods,
): InstancePaths {
  return {
    overwriteDir: runtimeOutput.folder,
    downloadsDir: downloaded.kind === 'listed' ? downloaded.downloadsDir : undefined,
    modDirs: new Map(entries.flatMap((entry) => {
      const folder = entry.kind === 'mod' ? modFolders?.holding(entry) : undefined;
      return folder === undefined ? [] : [[entry.name, folder.path] as const];
    })),
    sourceDirs: sourceDirsOf(entries, sourceMods),
  };
}

const emptyValue = (adapter: Pick<InstanceAdapter, 'names' | 'entryKey'>): InstanceValue => ({
  mods: [],
  modGroups: { ungrouped: [], groups: [] },
  modFolders: [],
  modNames: new Map(),
  trackedMods: new Set(),
  sourceMods: new Set(),
  holdsRepository: false,
  profiles: [],
  files: new FileConflictLookup(),
  filesByMod: new Map(),
  foldersByMod: new Map(),
  plugins: [],
  downloads: { kind: 'listed', rows: [] },
  activeProfile: '',
  managerNames: adapter.names,
  entryKey: (entry) => adapter.entryKey(entry),
  gameName: '',
  gameRelease: undefined,
  nexusDomainOf: nexusDomainForMetaGame,
  // Not read yet reads as not found, so a view that says not found waits for sequence 1.
  gameFolder: { kind: 'notFound', looked: [], setting: GAME_FOLDER_SETTING },
  dataFolderPlugins: { kind: 'unresolved' },
  pluginsLoadedWithNoLine: undefined,
  loadOrderSnapshot: undefined,
  overwriteFiles: [],
  overwriteFolders: [],
  paths: { overwriteDir: undefined, downloadsDir: undefined, modDirs: new Map(), sourceDirs: new Map() },
});

export class Instance implements Subscription {
  private current: InstanceValue;

  private seq = 0;

  private failure: string | undefined;

  private subscribers: InstanceSubscriber[] = [];

  private failureListeners: ReadFailureListener[] = [];

  private timer: ReturnType<typeof setTimeout> | undefined;

  // Recomputes never overlap, so a slow walk cannot publish over a newer one.
  private queue: Promise<unknown> = Promise.resolve();

  private quiets = 0;

  private quietEpoch = 0;

  private readonly changes: Subscription;

  private readonly focus: Subscription;

  // A note is one Output line until its text changes or it clears.
  private readonly told = new Map<NoteKind, ReadonlySet<string>>();

  constructor(private readonly options: InstanceOptions) {
    this.current = emptyValue(options.adapter);
    this.changes = options.adapter.subscribe(() => this.schedule());
    let focused = options.window.state.focused;
    this.focus = options.window.onDidChangeWindowState((state) => {
      if (state.focused && !focused) this.schedule();
      focused = state.focused;
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

  /** The latest recompute's failure reason, undefined once a recompute lands. Held, not just
   *  fired, so a tree subscribing after the failure still hears it. */
  get readFailure(): string | undefined {
    return this.failure;
  }

  /** Called with each landed value and the sequence it landed at, never with a failure. */
  subscribe(subscriber: InstanceSubscriber): Subscription {
    this.subscribers.push(subscriber);
    return {
      dispose: () => {
        this.subscribers = this.subscribers.filter((s) => s !== subscriber);
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

  /** The recompute activation runs, and the one that corrects the value after a change the
   *  adapter never signalled. Identical to the one a signal runs. Settles when its read has run;
   *  a read that overlapped `quiet` is dropped, not landed. */
  refresh(): Promise<void> {
    clearTimeout(this.timer); // a refresh mid-burst is the burst's recompute, not a second one
    return this.run();
  }

  /** Runs `work`, a write to several files the value reads, then refreshes. A read that overlapped
   *  it never lands: it may hold some files from before the write and some after. */
  async quiet<T>(work: () => Promise<T>): Promise<T> {
    this.quietEpoch++;
    this.quiets++;
    try {
      return await work();
    } finally {
      this.quiets--;
      this.quietEpoch++;
      await this.refresh();
    }
  }

  /** The value once the first read has landed: reads when none has, and holds the read it has. */
  async landed(): Promise<InstanceValue> {
    if (this.seq === 0) await this.refresh();
    return this.value;
  }

  /** For each file of the value it holds, by its path, which of its providers' copies are the
   *  same, or why a copy could not be read. */
  sameCopies(relativePaths: readonly string[]): Promise<FileCopies[]> {
    return sameCopies(this.options.adapter, this.current, relativePaths);
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.changes.dispose();
    this.focus.dispose();
    this.subscribers = [];
    this.failureListeners = [];
  }

  private tellReading({ skippedLinks, archiveListNotes, orderNotes, sourceMods, runtimeOutput, dataFolderPlugins, dataFolderArchives }: InstanceReading): void {
    const notes = [...runtimeOutput.notes.map((n) => `${runtimeOutput.origin}: ${n}`), ...sourceMods.notes];
    this.tellOnce('notes', notes.map((note) => `[instance] ${note}`), 'info');
    this.tellOnce('links', [...skippedLinks].map(([name, reason]) => `[instance] mods/${name} is a link Modbench cannot follow, so it is not a mod folder: ${reason}`), 'info');
    this.tellOnce('orderNotes', orderNotes.map((note) => `[instance] ${note}`), 'warn');
    this.tellOnce('archiveListNotes', archiveListNotes.map((note) => `[instance] ${note}`), 'warn');
    // An unreadable Data folder or its archives is an answer, never a failed read: the whole value
    // would otherwise go stale over a folder outside the instance.
    this.tellOnce('dataFolder', dataFolderPlugins.kind === 'unreadable' ? [`[instance] the game's Data folder could not be listed: ${dataFolderPlugins.reason}`] : [], 'warn');
    this.tellOnce('gameArchives', dataFolderArchives.kind === 'unreadable' ? [`[instance] the game's archives and strings files could not be listed: ${dataFolderArchives.reason}`] : [], 'warn');
  }

  private tellOnce(kind: NoteKind, lines: readonly string[], level: 'info' | 'warn'): void {
    const before = this.told.get(kind);
    for (const line of lines) if (!before?.has(line)) this.options.log[level](line);
    this.told.set(kind, new Set(lines));
  }

  // xEdit reports a listed archive it cannot find; the game loads none, so the views stay true.
  private tellArchivesNothingHolds(sources: ArchiveSources): void {
    const missing = listedArchivesNothingHolds(sources);
    this.tellOnce('archives', missing.map((name) => `[instance] The game's INIs list the archive ${name}, which no mod, Overwrite or game folder holds.`), 'info');
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.run(), SETTLE_MS);
  }

  private run(): Promise<void> {
    const task = this.queue.then(() => this.recompute());
    this.queue = task;
    return task;
  }

  // A read that throws logs and leaves the last value and the last sequence in place, so a file
  // another tool is half-way through writing never empties the trees.
  private async recompute(): Promise<void> {
    let next: InstanceValue;
    const epoch = this.quietEpoch;
    try {
      next = await this.read();
    } catch (err) {
      if (epoch !== this.quietEpoch || this.quiets > 0) return;
      const failure = errorMessage(err);
      this.options.log.error(`[instance] Failed to read the instance: ${failure}`);
      this.failure = failure;
      this.notify(this.failureListeners, (listener) => listener());
      return;
    }
    if (epoch !== this.quietEpoch || this.quiets > 0) return;
    this.current = next;
    this.failure = undefined;
    this.seq++;
    this.notify(this.subscribers, (subscriber) => subscriber(next, this.seq));
  }

  // A throwing subscriber would otherwise reject the queue for good, and no later recompute
  // would run — the dead chain tail every write queue's tail-catch documents.
  private notify<T>(listeners: readonly T[], call: (listener: T) => void): void {
    for (const listener of [...listeners]) {
      try {
        call(listener);
      } catch (err) {
        this.options.log.error(`[instance] subscriber threw at sequence ${this.seq}: ${errorMessage(err)}`);
      }
    }
  }

  private async read(): Promise<InstanceValue> {
    const { adapter, log } = this.options;
    const reading = await adapter.reading();
    const {
      profile, gameName, gameRelease, mods: entries, pluginOrder, downloadedFiles: downloadsOutcome, gameFolder, dataFolderPlugins,
      creationClubList: creationClub, dataFolderArchives, runtimeOutput, modFolders, profiles, sourceMods,
    } = reading;
    this.tellReading(reading);
    const index = buildFileConflictIndex(entries, runtimeOutput.files, reading.modFiles, (line) => log.info(line));
    const plugins = buildLoadOrderRows(pluginOrder, index, runtimeOutput.files, gameFolder, dataFolderPlugins);
    const pluginsLoadedWithNoLine = pluginsLoadedWithNoLineOf(loadedWithNoLineOf(gameRelease, creationClub), dataFolderPlugins, plugins);
    // Installed reads every mod folder, not one profile's mod order: a folder no profile has synced
    // into its mod order yet still owns its meta's claim. A separator is never installed from a
    // downloaded file.
    const installedInto = modsByArchiveFilename(
      [...reading.folderMeta].map(([name, meta]) => ({ name, archiveFilename: meta.archiveFilename })),
    );
    const modFolderList = modFolders?.all;
    const modNames = modNamesOf(entries, modFolders);
    const paths = pathsOf(runtimeOutput, downloadsOutcome, entries, modFolders, sourceMods);
    const archiveSources: ArchiveSources = {
      gameRelease, listed: reading.archiveList, inData: dataFolderArchives, files: index.files,
      filesByOrigin: new Map([...index.filesByMod, [OVERWRITE_ORIGIN, runtimeOutput.files]]),
    };
    this.tellArchivesNothingHolds(archiveSources);
    const loadOrderSnapshot = loadOrderSnapshotOf({
      plugins, gameFolder, pluginsLoadedWithNoLine, modFolders, sourceDirs: paths.sourceDirs, places: pluginPlacesOf({ mods: entries, paths }), archives: archiveSources,
      modlist: { mods: entries, metadataFiles: adapter.metadataFilesInModFolder, statCache: adapter.statCacheFolder },
    });
    return {
      mods: entries,
      modGroups: reading.modGroups,
      modFolders: modFolderList,
      modNames,
      trackedMods: new Set(entries.flatMap((entry) => (entry.kind === 'mod' && paths.sourceDirs.has(entry.name) ? [entry.name] : []))),
      sourceMods: new Set(paths.sourceDirs.keys()),
      holdsRepository: reading.holdsRepository,
      profiles,
      files: index.files,
      filesByMod: index.filesByMod,
      foldersByMod: index.foldersByMod,
      plugins,
      downloads: downloadsOutcome.kind === 'unresolved'
        ? { kind: 'unresolved', reason: downloadsOutcome.reason }
        : {
          kind: 'listed',
          rows: downloadsOutcome.files ? buildDownloadRows(downloadsOutcome.files, installedInto, entries) : [],
        },
      activeProfile: profile,
      managerNames: adapter.names,
      entryKey: (entry) => adapter.entryKey(entry),
      gameName,
      nexusDomainOf: nexusDomainForMetaGame,
      gameRelease,
      gameFolder,
      dataFolderPlugins,
      pluginsLoadedWithNoLine,
      loadOrderSnapshot: loadOrderSnapshot === undefined || 'refusal' in loadOrderSnapshot
        ? loadOrderSnapshot
        : await withMetadata(await stampedSnapshot(loadOrderSnapshot, (path) => adapter.fileStamp(path)), entries, modNames, adapter),
      overwriteFiles: runtimeOutput.files,
      overwriteFolders: runtimeOutput.folders,
      paths,
    };
  }
}

async function withMetadata(
  snapshot: LoadOrderSnapshotValue, entries: readonly ModlistEntry[], modNames: ReadonlyMap<string, string>,
  { metadataOf }: Pick<InstanceAdapter, 'metadataOf'>,
): Promise<LoadOrderSnapshotValue> {
  const metaOf = new Map(entries.flatMap((entry) => {
    const name = modNameOf(modNames, entry);
    return name === undefined ? [] : [[name, entry.kind === 'mod' ? entry : {}] as const];
  }));
  const mods = await withMetadataRead(snapshot.mods, async (name) => ({ kind: 'read' as const, answer: await metadataOf(present(metaOf.get(name), name)) }));
  return { ...snapshot, mods };
}

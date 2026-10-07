// The Instance adapter's interface: a repository over one instance, answering parsed reads and
// taking changes in domain words. Each mod manager is one implementation of it, beside it in this
// box, and names itself through `names`.

import type { PluginEntry } from '../loadOrderFileCodec/pluginsText';
import type { MoveToTrash } from '../ports/trash';

export type { PluginEntry } from '../loadOrderFileCodec/pluginsText';
export { fileExtension, isPluginFile } from './pluginFile';
export { fileInFolder, isPluginSourcePath } from './layout';

/** The reserved origin of the files the game wrote at run time (ADR-0012). */
export { OVERWRITE_DIR_NAME as OVERWRITE_ORIGIN } from './codecs/modlistText';

/** The setting that names the game folder outright, and so the one that fixes a folder not found. */
export const GAME_FOLDER_SETTING = 'modbench.mods.gameDirectory';

/** What the user set, read fresh on each resolve by whoever built the resolver. */
export interface GameDirectoryOverrides {
  /** The game folder outright (`GAME_FOLDER_SETTING`). */
  gameDirectory?: string;
}

/** One place Modbench looked for the game folder, and what it found there. */
export interface GameFolderLook {
  readonly place: string;
  readonly answer: string;
}

/** Where the game is, or each place Modbench looked for it and why none answered. Not finding it
 *  is an answer, never a failed read: every row that does not need the game folder still shows. */
export type GameFolder =
  | {
    readonly kind: 'found';
    /** Folder containing the game executable and Data/. */
    readonly root: string;
    readonly dataFolder: string;
  }
  | {
    readonly kind: 'notFound';
    /** In the order Modbench looked; a place after one that refused to fall through is absent. */
    readonly looked: readonly GameFolderLook[];
    readonly setting: string;
  };

/** A Nexus mod and file id pair recorded as installed into a mod. */
export interface InstalledFileId {
  nexusId: string;
  fileId: string;
}

/** What a mod's metadata says; a field is undefined when absent or empty. */
export interface ModMeta {
  version?: string;
  nexusId?: string;
  archiveFilename?: string;
  /** In index order; undefined when none are recorded. */
  installedFiles?: readonly InstalledFileId[];
}

export interface Mod extends ModMeta {
  kind: 'mod';
  name: string;
  enabled: boolean;
}

export interface Separator {
  kind: 'separator';
  name: string;
  enabled: boolean;
}

/** One entry in mod order. */
export type ModlistEntry = Mod | Separator;

/** A mod or a separator, by its kind and name. */
export type EntryRef = Pick<ModlistEntry, 'kind' | 'name'>;

/** Why a change naming an entry mod order does not list is refused. */
export const entryNotFound = (entry: EntryRef): string =>
  `${entry.kind === 'mod' ? 'Mod' : 'Separator'} not found in modlist: ${entry.name}`;

/** A folder that holds a mod or a separator, decoded into the entry it holds. */
export interface ModFolder {
  readonly kind: ModlistEntry['kind'];
  readonly name: string;
  readonly path: string;
}

/** An end of mod order. */
export type OrderEnd = 'winning' | 'losing';

/** Where a move lands: among a separator's mods, among the ungrouped mods, beside a mod, or at an
 *  end of the whole mod order. Mods take any of them; separators take a `SeparatorsPlace`. */
export type MovePlace =
  | { kind: 'ungrouped' }
  | { kind: 'separator'; name: string }
  | { kind: 'mod'; name: string }
  | { kind: 'modOrder' };

/** Where moved separators land: beside a separator and its mods, or at an end of mod order. */
export type SeparatorsPlace = Extract<MovePlace, { kind: 'separator' | 'modOrder' }>;

/** The metadata keys Modbench writes into a mod's meta. */
export interface OwnedMetaKeys {
  gameName: string;
  nexusId?: string;
  version?: string;
  archiveFilename?: string;
  installedFiles?: readonly InstalledFileId[];
}

export type DownloadStatus = 'Installed' | 'Uninstalled' | 'Downloaded';

/** What a downloaded file's metadata says. `status` is the metadata's own claim, never
 *  corroborated against the mods. */
export interface DownloadMeta {
  status: DownloadStatus;
  /** A separate axis from `status`. */
  excluded: boolean;
  modID?: string;
  fileID?: string;
  name?: string;
  version?: string;
  modName?: string;
  gameName?: string;
  author?: string;
}

/** A downloaded file, with its metadata parsed; `meta` is undefined when it has none. */
export interface DownloadedFile {
  readonly name: string;
  readonly path: string;
  /** Where its metadata is, or would be. */
  readonly metaPath: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly meta: DownloadMeta | undefined;
}

/** The downloaded files, or why their folder could not be resolved. `files` is undefined when the
 *  resolved folder is not there. */
export type DownloadedFiles =
  | { readonly kind: 'listed'; readonly downloadsDir: string; readonly files: readonly DownloadedFile[] | undefined }
  | { readonly kind: 'unresolved'; readonly reason: string };

/** The plugin files at the root of the game folder's Data folder, case-folded; or why there is no
 *  answer: a game folder not found, or a Data folder that could not be listed. */
export type DataFolderPlugins =
  | { readonly kind: 'listed'; readonly names: ReadonlySet<string> }
  | { readonly kind: 'unresolved' }
  | { readonly kind: 'unreadable'; readonly reason: string };

/** An entry directly in an extracted folder. */
export interface ExtractedEntry {
  readonly name: string;
  readonly kind: 'folder' | 'file' | 'other';
}

/** A release on its way into a mod's own folder, in a fresh folder of its own inside it. Only the
 *  adapter makes one, and it removes only what it made. */
export interface ModExtraction {
  /** Where the release is extracted. */
  readonly path: string;
  /** Puts a copy of `folder`'s tree in `path`; `folder` is left as it was. */
  copyIn(folder: string): Promise<void>;
  /** Undoes the extraction: a new mod's folder goes whole; an upgrade's folder keeps everything
   *  but the extraction. */
  abandon(): Promise<void>;
}

export interface NewModExtraction extends ModExtraction {
  /** Makes the tree at `root` the mod's contents, its meta holding `keys` alone. */
  land(root: string, keys: OwnedMetaKeys): Promise<void>;
}

export interface UpgradeExtraction extends ModExtraction {
  /** Replaces the mod's contents with the tree at `root` around its repository and plugin source,
   *  setting `keys` over the meta and keeping each value `keys` leaves undefined. A release
   *  holding an entry of either is refused first. */
  land(root: string, keys: OwnedMetaKeys): Promise<Upgraded>;
}

type Upgraded = { readonly refused: false } | { readonly refused: true; readonly repositoryOrPluginSourceEntry: string };

interface InstanceSettings {
  readonly profile: string;
  /** The game as the mod manager's configuration names it. */
  readonly gameName: string;
  /** Mutagen's release of that game; undefined when the tables hold none for it. */
  readonly gameRelease: string | undefined;
  gameFolder(): Promise<GameFolder>;
  downloadedFiles(): Promise<DownloadedFiles>;
}

/** Names match as the manager matches them. An entry added at the winning end is disabled. A
 *  separator takes its folder's name; one added is enabled, gets its folder, and lands after the
 *  entry at `afterIndex`, first at -1. */
export type ModOrderChange =
  | { readonly kind: 'enable'; readonly mod: string; readonly enabled: boolean }
  | { readonly kind: 'moveMods'; readonly mods: readonly string[]; readonly place: MovePlace; readonly end: OrderEnd }
  | {
    readonly kind: 'moveSeparators';
    readonly separators: readonly string[];
    readonly place: SeparatorsPlace;
    readonly end: OrderEnd;
  }
  | { readonly kind: 'addAtWinningEnd'; readonly entry: EntryRef }
  | { readonly kind: 'addSeparator'; readonly separator: string; readonly afterIndex: number }
  | { readonly kind: 'renameSeparator'; readonly from: string; readonly to: string }
  | { readonly kind: 'renameMod'; readonly from: string; readonly to: string }
  | { readonly kind: 'dropMod'; readonly mod: string }
  | { readonly kind: 'dropSeparator'; readonly separator: string };

/** Plugin names compare as ADR-0012 says. A plugin added is
 *  disabled and lands at the winning end; a move lands its plugins, in their own order, at
 *  `toIndex` among the plugins that remain. */
export type PluginOrderChange =
  | { readonly kind: 'enable'; readonly plugin: string; readonly enabled: boolean }
  | { readonly kind: 'move'; readonly plugins: readonly string[]; readonly toIndex: number }
  | { readonly kind: 'add'; readonly plugin: string }
  | { readonly kind: 'drop'; readonly plugin: string };

/** A mark on a downloaded file's metadata: a status its metadata claims, or excluded or not. */
export type DownloadedFileMark = 'Installed' | 'Uninstalled' | 'Excluded' | 'Included';

/** The mod folders as they stand, and which of them holds an entry, matched as the manager
 *  matches names. */
export interface ModFolders {
  readonly all: readonly ModFolder[];
  holding(entry: EntryRef): ModFolder | undefined;
}

/** Decides the changes to mod order from the order, and the mod folders, as they stand when the
 *  changes land; `folders` is undefined when there is no folder for mods at all. */
export type DecideModOrder = (order: readonly ModlistEntry[], folders: ModFolders | undefined) => readonly ModOrderChange[];

/** Decides the changes to plugin order from the order as it stands when the changes land. */
export type DecidePluginOrder = (order: readonly PluginEntry[]) => readonly PluginOrderChange[];

interface Written {
  readonly wrote: boolean;
}

type Marked = { readonly gone: true } | ({ readonly gone: false } & Written);

/** A mark on a file of an origin, with the path it has once marked, or why it was refused before
 *  anything changed. */
export type OriginFileMarked =
  | { readonly gone: true }
  | { readonly gone: false; readonly wrote: boolean; readonly relativePath: string }
  | { readonly gone: false; readonly refusal: string };

/** Whether the game gets a file of a mod or of Overwrite. */
export type OriginFileMark = 'Excluded' | 'Included';

/** What a subscriber disposes of to hear no more. */
export interface Subscription {
  dispose(): void;
}

/** Where a file's contents come from: a mod, or the files the game wrote at run time. */
export type FileOrigin = { readonly kind: 'mod'; readonly name: string } | { readonly kind: 'runtimeOutput' };

/** A folder in an origin, by the relative path the origin's own tree names it with, where it
 *  sits, and whether the mod manager keeps it from the game, by its own mark or a folder's above
 *  it. */
export interface OriginFolder {
  readonly relativePath: string;
  readonly path: string;
  readonly excluded: boolean;
}

/** A file in an origin, as a folder is, and where it is read from: a link's target.
 *  `excludedByName` holds when its own name carries the mark, whatever its folder's. */
export interface OriginFile extends OriginFolder {
  readonly sourcePath: string;
  readonly excludedByName: boolean;
}

/** An origin's files: the origin they take, the folder they are in (none for a name that gives
 *  it none), each file, and each folder below it. `notes` names each entry the listing skipped,
 *  one line apiece. */
export interface OriginFiles {
  readonly origin: string;
  readonly folder: string | undefined;
  readonly files: readonly OriginFile[];
  readonly folders: readonly OriginFolder[];
  readonly notes: readonly string[];
}

/** What the file system says of a file without a read of its bytes. A tool can keep a file's size
 *  and date modified across a write, never the time of its change. */
export interface FileStamp {
  readonly size: bigint;
  readonly modifiedNs: bigint;
  readonly changedNs: bigint;
}

/** A read of one file that answers why it could not be read, rather than failing whatever asked. */
export type FileRead<T> = { readonly kind: 'read'; readonly answer: T } | { readonly kind: 'unreadable'; readonly reason: string };

/** How a message names the mod manager, the file it keeps mod order in, and the file it keeps beside a downloaded file. */
export interface ManagerNames {
  readonly manager: string;
  readonly modOrderFile: string;
  readonly downloadMetadataFile: string;
}

export interface InstanceAdapter {
  // Parsed reads.
  readonly names: ManagerNames;
  settings(): Promise<InstanceSettings>;
  /** Every profile's name; none when the instance has no profiles. */
  profiles(): Promise<string[]>;
  modOrder(profile: string): Promise<ModlistEntry[]>;
  /** The entry of `entry`'s kind mod order lists, matched as the manager matches names; undefined
   *  when it lists none. */
  orderEntry(profile: string, entry: EntryRef): Promise<ModlistEntry | undefined>;
  /** Empty when the mod has no metadata. */
  modMeta(mod: string): Promise<ModMeta>;
  pluginOrder(profile: string): Promise<PluginEntry[]>;
  gameFolderPlugins(gameFolder: GameFolder): Promise<DataFolderPlugins>;
  /** The plugins the game folder's Creation Club list names, in its order; none when the release
   *  has no Creation Club, the game folder is not found, or it holds no list. */
  creationClubList(gameFolder: GameFolder, gameRelease: string | undefined): Promise<string[]>;
  /** The name of the downloaded file at `path`, the paths matched as the platform matches them;
   *  undefined when `path` is not in the downloads folder, or that folder cannot be resolved. */
  downloadedFileAt(path: string): Promise<string | undefined>;

  // Get in mods/.
  /** Undefined when there is no folder for mods at all. A link that cannot be followed is no
   *  folder, and is handed to `skippedLink`. */
  modFolders(skippedLink?: (name: string, reason: string) => void): Promise<ModFolders | undefined>;
  /** The folder that holds `entry`, matched as the manager matches names; undefined when none does. */
  entryFolder(entry: EntryRef): Promise<ModFolder | undefined>;
  /** An origin's files, none when its folder is not there. */
  originFiles(origin: FileOrigin): Promise<OriginFiles>;
  /** ADR-0007. */
  modTracked(mod: string): Promise<boolean>;
  /** The stamp of an origin file, at the path it is read from. */
  fileStamp(path: string): Promise<FileRead<FileStamp>>;
  /** The content digest of an origin file, at the path it is read from: two files with one digest
   *  hold the same bytes. */
  contentDigest(path: string): Promise<FileRead<string>>;

  // Changes.
  /** Every change lands in one write, its folders with it. Naming an entry not there, or adding a
   *  separator that is, rejects all of it. Adding at the winning end an entry there, or dropping
   *  one not there, changes nothing. */
  changeModOrder(profile: string, decide: DecideModOrder): Promise<Written>;
  /** Every change lands in one write. A change naming a plugin that is not there rejects, and
   *  nothing is written. Adding a plugin that is there changes nothing. */
  changePluginOrder(profile: string, decide: DecidePluginOrder): Promise<Written>;
  /** A downloaded file that is gone gets no mark. Rejects when the downloads folder cannot be
   *  resolved. */
  markDownloadedFile(name: string, mark: DownloadedFileMark): Promise<Marked>;
  /** False when the downloaded file has no metadata. A write of the metadata a crash left half
   *  done goes with it. */
  trashDownloadedFileMeta(name: string, trash: MoveToTrash): Promise<boolean>;
  selectProfile(profile: string): Promise<Written>;

  // Put and rename in mods/.
  /** Refuses a folder already there, whatever it holds, matched as the manager matches names. */
  createModFolder(mod: string): Promise<void>;
  /** Renames the folder that holds `from` to `to`, in place. Refuses when none holds `from`, and a
   *  folder already there under another name, matched as the manager matches names. */
  renameModFolder(from: string, to: string): Promise<void>;
  /** Marks a file or folder by its own name; a mark already true changes nothing. Refuses an
   *  include on an unmarked name a folder excludes, and a mark replacing a file. Rejects a path
   *  outside the origin. */
  markOriginFile(origin: FileOrigin, relativePath: string, mark: OriginFileMark): Promise<OriginFileMarked>;
  /** Renames plugin `from` of `origin`, its named files and its line in every profile, in one
   *  write; a failed write puts every file back. Refuses, changing nothing, a taken name or a
   *  plugin not there. */
  renamePlugin(origin: FileOrigin, from: string, to: string, gameRelease: string | undefined): Promise<void>;
  /** The refusal `renamePlugin` would make before it writes, or applied; it writes nothing itself. */
  checkPluginRename(
    origin: FileOrigin, from: string, to: string, gameRelease: string | undefined,
  ): Promise<{ applied: true } | { applied: false; refusal: string }>;
  /** Moves the folder that holds `entry` out of mods/ into the trash; false when none does. */
  trashEntryFolder(entry: EntryRef, trash: MoveToTrash): Promise<boolean>;
  /** Makes the folder of a mod that is new. Refuses a folder already there, whatever it holds,
   *  matched as the manager matches names. */
  extractNewMod(mod: string): Promise<NewModExtraction>;
  /** Opens the extraction inside the folder of a mod that is there; rejects when none holds it. */
  extractUpgrade(mod: string): Promise<UpgradeExtraction>;
  extractedEntries(folder: string): Promise<ExtractedEntry[]>;

  // Subscribe: the instance changed.
  /** Hears that the instance changed: any of its files, the downloads folder and the game folder's
   *  plugins, where the last read of the settings resolved them. */
  subscribe(listener: () => void): Subscription;
}

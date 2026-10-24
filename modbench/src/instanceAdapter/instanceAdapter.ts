// The Instance adapter's interface: a repository over one instance, answering parsed reads and
// taking changes in domain words. A mod manager or a publisher implements it in this box; a mod
// manager names itself through `names`.

import { join } from 'node:path';
import type { PluginEntry } from '../loadOrderFileCodec/pluginsText';
import type { MoveToTrash } from '../ports/trash';
import type { NexusFileInfo } from '../ports/nexusFileInfo';
import type { NexusPage } from './nexusPage';
import { PLUGIN_SOURCE_FOLDER } from '../wire/sourceMod';
import type { FomodMove, FomodState, ReleaseImage } from '../wire/fomodPage';

export type { PluginEntry } from '../loadOrderFileCodec/pluginsText';
export { dataFolderFile } from './gameFolder/dataFolder';

export type { InstallationFileReader } from './downloadedFileContents/installationFileReader';
export { INSTALLATION_FILE_EXTENSIONS } from './downloadedFileContents/installationFileNames';
export { downloadedFileReader } from './downloadedFileContents/downloadedFileReader';

/** The setting that names the game folder outright: its id
 *  is what fixes a folder not found, its value is read fresh on each resolve, and a change is heard
 *  through `changed`. */
export interface GameFolderSetting {
  readonly id: string;
  readonly value: () => string | undefined;
  readonly changed: (listener: () => void) => Subscription;
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

/** What a mod's metadata says; a field is undefined when absent or empty. */
export interface ModMeta {
  gameName?: string;
  version?: string;
  /** Whether the mod manager shows an update for the mod, by the newest version it recorded. */
  updateAvailable?: boolean;
  nexusId?: string;
  installationFileName?: string;
  /** The keys, as a downloaded file's `installedKey` spells them, of the files it was installed from; undefined when none are recorded. */
  installedFileKeys?: readonly string[];
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

/** A separator and the mods it holds: those between it and the previous separator, toward the winning end. */
export interface ModGroup {
  readonly separator: Separator;
  readonly mods: readonly Mod[];
}

/** Mod order grouped by separator, winning-first like the order. The mods after the last separator, on the losing side, are ungrouped. */
export interface ModGroups {
  readonly ungrouped: readonly Mod[];
  readonly groups: readonly ModGroup[];
}

/** A mod or a separator, by its kind and name. */
export type EntryRef = Pick<ModlistEntry, 'kind' | 'name'>;

/** Whether two entries are one to the mod manager: the same kind, and the same key. */
export const sameEntry = (manager: Pick<InstanceAdapter, 'entryKey'>, a: EntryRef, b: EntryRef): boolean =>
  a.kind === b.kind && manager.entryKey(a) === manager.entryKey(b);

/** Why a change naming an entry mod order does not list is refused. */
export const entryNotFound = (entry: EntryRef): string =>
  `${entry.kind === 'mod' ? 'Mod' : 'Separator'} not found in modlist: ${entry.name}`;

/** A folder that holds a mod or a separator, decoded into the entry it holds. */
export interface ModFolder {
  readonly kind: ModlistEntry['kind'];
  readonly name: string;
  readonly path: string;
  /** The name the mod manager knows the folder's mod by; a separator's is not its name. */
  readonly modName: string;
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

/** What the caller supplies for the record an install leaves with the mod; the adapter adds what it knows of the instance. */
export type InstallKeys = Pick<ModMeta, 'nexusId' | 'version' | 'installationFileName' | 'installedFileKeys'> & { readonly nexusFileStatus?: number };

export type DownloadedFileStatus = 'Installed' | 'Uninstalled' | 'Downloaded';

/** What a downloaded file's metadata says. `status` is the metadata's own claim, never
 *  corroborated against the mods. */
export interface DownloadedFileMeta {
  status: DownloadedFileStatus;
  modID?: string;
  fileID?: string;
  /** The Nexus file category the metadata records; absent when it records none. */
  fileCategory?: number;
  name?: string;
  version?: string;
  modName?: string;
  gameName?: string;
  author?: string;
  /** The key a mod's `installedFileKeys` holds for this file, minted by the adapter; undefined when the metadata names no file. */
  installedKey?: string;
}

/** A downloaded file, with its metadata parsed; `meta` is undefined when it has none. `excluded` is a separate
 *  axis from the metadata's `status`. */
export interface DownloadedFile {
  readonly name: string;
  readonly path: string;
  /** Where its metadata is, or would be. */
  readonly metadataPath: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly excluded: boolean;
  readonly meta: DownloadedFileMeta | undefined;
  /** The Nexus mod ID install gives the mod: the metadata's, else the file name's. `meta.modID` stays the metadata's own claim. */
  readonly modID?: string;
}

/** What Nexus is asked about a downloaded file: its MD5, the Nexus games to ask in order, and the IDs its metadata or its name gives. */
export interface DownloadedFileQuery {
  readonly games: readonly string[];
  readonly md5: string;
  readonly modID?: string;
  readonly fileID?: string;
}

/** The downloaded files, or why their folder could not be resolved. `files` is undefined when the
 *  resolved folder is not there. */
export type DownloadedFiles =
  | { readonly kind: 'listed'; readonly downloadsDir: string; readonly files: readonly DownloadedFile[] | undefined }
  | { readonly kind: 'unresolved'; readonly reason: string };

/** The plugin files at the root of the game folder's Data folder, as the folder spells them; or why
 *  there is no answer: a game folder not found, or a Data folder that could not be listed. */
export type DataFolderPlugins =
  | { readonly kind: 'listed'; readonly names: ReadonlySet<string> }
  | { readonly kind: 'unresolved' }
  | { readonly kind: 'unreadable'; readonly reason: string };

/** Each plugin the game can load, keyed as it compares names, spelled as the copy it loads: an
 *  enabled mod's or Overwrite's at their root, else the Data folder's; and the enabled mods, by name. */
export type PluginsProvided =
  | {
    readonly kind: 'listed'; readonly plugins: ReadonlyMap<string, string>; readonly loadedWithNoLine: readonly string[];
    readonly enabledMods: readonly string[];
  }
  | Exclude<DataFolderPlugins, { readonly kind: 'listed' }>;

/** The release's archives at the Data folder's root, and the strings files in its strings folder by
 *  their paths in it, as the folder spells them; or why there is no answer, as for its plugins. */
export type DataFolderArchives =
  | { readonly kind: 'listed'; readonly archives: readonly string[]; readonly stringsFiles: readonly string[] }
  | { readonly kind: 'unresolved' }
  | { readonly kind: 'unreadable'; readonly reason: string };

/** Where a mod's files come from: an installation file, extracted, or a folder, copied and left as it was. */
export type InstallPackage = { readonly kind: 'archive'; readonly path: string } | { readonly kind: 'folder'; readonly path: string };

/** Which mod an install fills, settled by the caller: the folder on disk is checked against the
 *  claim, never consulted to decide it. */
export interface InstallTarget {
  readonly kind: 'new' | 'upgrade';
  readonly name: string;
}

/** The options picked in one group of a FOMOD's step, each by the name its installer shows. */
export interface FomodGroupChoice {
  readonly group: string;
  readonly options: readonly string[];
}

/** The choices made on one of a FOMOD's steps, by the name its installer shows. */
export interface FomodStepChoice {
  readonly step: string;
  readonly groups: readonly FomodGroupChoice[];
}

/** The page a user answers a FOMOD's installer on. A state's images are paths in `release`, the extracted FOMOD's
 *  folder. */
export interface FomodDialog {
  readonly show: (state: FomodState<ReleaseImage>, release: string) => void;
  readonly onMove: (handler: (move: FomodMove) => void) => void;
  readonly confirmMissing: (missing: readonly string[]) => Promise<boolean>;
  /** Whether the install now waits on the user, and not on itself. */
  readonly asking: (asking: boolean) => void;
  readonly close: () => void;
}

/** How a FOMOD's installer is answered: its choices, step by step; the user's moves on its page; or Manual, which
 *  installs a plain copy. */
export type FomodAnswer =
  | { readonly kind: 'choices'; readonly steps: readonly FomodStepChoice[] }
  | { readonly kind: 'dialog'; readonly dialog: FomodDialog }
  | { readonly kind: 'manual' };

/** A FOMOD its installer installed, with each file its archive lacks and anything else it said; or a plain copy, and
 *  why its installer did not run. */
export type FomodLanded =
  | { readonly kind: 'installer'; readonly missing: readonly string[]; readonly notes: readonly string[] }
  | { readonly kind: 'plainCopy'; readonly why: string };

/** An install that landed, and how, when its package is a FOMOD; or none, because the target's folder is there for a
 *  new mod or absent for an upgrade; or none, because the user cancelled the FOMOD's installer. */
export type InstallOutcome =
  | { readonly landed: true; readonly fomod?: FomodLanded }
  | { readonly landed: false; readonly cancelled?: true };

/** Names match as the manager matches them. An entry added at the winning end is disabled. A
 *  separator added is enabled and gets its folder, after its `anchor` mod or before the
 *  first mod of its `anchor` separator's group. */
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
  | { readonly kind: 'addSeparator'; readonly separator: string; readonly anchor: EntryRef }
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

/** Decides as `DecidePluginOrder` does, and from the plugins provided as they stand then too. */
export type DecidePluginOrderOverProvided = (order: readonly PluginEntry[], provided: PluginsProvided) => readonly PluginOrderChange[];

interface Written {
  readonly wrote: boolean;
}

interface ModOrderWritten extends Written {
  /** The changes with their names as written. */
  readonly landed: readonly ModOrderChange[];
}

type DownloadedFileTrashed = { readonly gone: true } | { readonly gone: false; readonly metadataLeftBehind?: string };

type Marked = { readonly gone: true } | ({ readonly gone: false } & Written);

/** A mark on a file of an origin, with the path it has once marked, or why it was refused before
 *  anything changed. */
export type OriginFileMarked =
  | { readonly gone: true }
  | { readonly gone: false; readonly wrote: boolean; readonly relativePath: string }
  | { readonly gone: false; readonly refusal: string };

/** Every repository in the source folder, listed in the mod order or not, by the mod its build configuration
 *  names as its output (ADR-0007). A note names each repository left out, and why. */
export interface SourceMods {
  readonly folders: ReadonlyMap<string, string>;
  /** The source folder that builds `mod`, its name matched as the manager matches names. */
  folderOf(mod: string): string | undefined;
  readonly notes: readonly string[];
}

/** A source mod's repository as the instance repository holds it (ADR-0023): the folder git checks it out in, the commit
 *  the instance repository pins and the branch it follows. */
export interface Submodule { readonly folder: string; readonly pin: string; readonly branch?: string }

/** Where a clone fetches a source mod's repository from: its remote's URL with no credential, or why it has no host
 *  (ADR-0023). */
export type SourceHost = { readonly kind: 'host'; readonly url: string } | { readonly kind: 'noRemote' } | { readonly kind: 'noHost'; readonly why: string };

/** Why one source mod is not as a submodule would be. */
export interface SubmoduleNote { readonly mod: string; readonly note: string }

interface SubmoduleReport { readonly notes: readonly SubmoduleNote[]; readonly other: readonly string[] }

// A path a file holds, the file by its path in the instance repository.
interface PathInFile { readonly file: string; readonly path: string }

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

/** A file in an origin, as a folder is, and where it is read from: a link's target. It carries
 *  the path it has when nothing excludes it; `markedExcluded` holds when its own mark excludes it. */
export interface OriginFile extends OriginFolder {
  readonly sourcePath: string;
  readonly includedPath: string;
  readonly markedExcluded: boolean;
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

export interface HashedFile {
  readonly size: number;
  readonly hash: string;
}

/** A game file by its forward-slash path under the game's Data folder, named as the game folder names it, with its hash. */
export interface GameFile {
  readonly path: string;
  readonly hash: string;
}

interface GameFilesRead {
  readonly files: readonly GameFile[];
  readonly unreadable: Readonly<Record<string, string>>;
}

// The game files a mod's files take, and each entry of its folder the listing skipped, one line apiece.
interface GameFilesTaken {
  readonly gameFiles: readonly GameFile[];
  readonly notes: readonly string[];
}

/** A downloaded file hashed whole and entry by entry. */
export interface HashedDownloadedFile extends HashedFile {
  /** Each entry by its forward-slash path inside the file. */
  readonly entries: readonly { readonly path: string; readonly hash: string }[];
}

/** A downloaded file the mod manager records a mod as installed from, with its hashes. */
export interface InstallationFile extends HashedDownloadedFile {
  readonly path: string;
  /** The file's page on its host, a string the Instance adapter formats and the rest keeps opaque. */
  readonly page?: string;
  /** The game the metadata names when the registry has no Nexus domain for it, so the file carries no page. */
  readonly unpagedGame?: string;
}

interface MetadataInstallationFile {
  readonly name: string;
  readonly page?: string;
}

/** A mod's place on Nexus: its game's Nexus domain, its ID, and the file installed, by ID and by name when the metadata records them. */
export interface NexusModFile {
  readonly game: string;
  readonly modId: string;
  readonly fileId: string | undefined;
  readonly fileName: string | undefined;
  /** Nexus's category of the installed file, as the metadata recorded it. */
  readonly fileStatus: number | undefined;
}

export interface ModMetadata {
  readonly version?: string;
  readonly installationFile?: MetadataInstallationFile;
}

/** How a message names the mod manager, the file it keeps mod order in, and the file it keeps beside a downloaded file. */
export interface ManagerNames {
  readonly manager: string;
  readonly modOrderFile: string;
  readonly downloadedFileMetadataFile: string;
}

// The game as the mod manager's configuration names it, and Mutagen's release of it.
interface InstanceGame {
  readonly gameName: string;
  readonly gameRelease: string;
}

/** Whether the mod manager that made the instance is running, or why Modbench cannot tell. */
export type ManagerRunning = { readonly kind: 'running' | 'notRunning' } | { readonly kind: 'unknown'; readonly reason: string };

/** A publisher tag as its publisher declares it (publishing.md, Publisher tags). */
export interface PublisherTag {
  readonly name: string;
  readonly badge: string;
  /** Whether it marks paths, or only mods. */
  readonly marksPaths: boolean;
}

/** Each publisher tag that covers the file or folder at `path`, as its publisher applies it; `mod` is the mod whose folder
 *  `path` is or is in, undefined outside every mod. */
export type Covering = (path: string, mod: string | undefined) => readonly PublisherTag[];

/** Each publisher tag the configuration lists on exactly the file or folder at `path`: what remove takes away. */
export type Listed = (path: string) => readonly PublisherTag[];

/** Adding a publisher tag, or removing it. */
export type PublisherTagChange = 'add' | 'remove';

interface FolderMove {
  readonly from: string;
  readonly to?: string;
}

/** A path a change to a publisher tag refused, and why. */
export interface PathRefusal {
  readonly path: string;
  readonly reason: string;
}

/** The publisher's configuration: none while the instance holds no publisher's, or why it could not be read. */
export type PublisherConfiguration =
  | { readonly kind: 'none' }
  | { readonly kind: 'read'; readonly covering: Covering; readonly listed: Listed }
  | { readonly kind: 'unreadable'; readonly reason: string };

/** The instance as parsed facts, every one from the same read of its settings, and what the watch cannot hear. */
export interface InstanceReading extends InstanceGame {
  /** The profile the mod manager's configuration selects. */
  readonly profile: string;
  /** Mod order, a mod's meta folded into its entry. */
  readonly mods: readonly ModlistEntry[];
  /** The same mod order grouped by separator. */
  readonly modGroups: ModGroups;
  /** Each line of mod order or plugin order the reading left out because an earlier line names the same entry. */
  readonly orderNotes: readonly string[];
  readonly pluginOrder: readonly PluginEntry[];
  readonly downloadedFiles: DownloadedFiles;
  readonly gameFolder: GameFolder;
  readonly dataFolderPlugins: DataFolderPlugins;
  readonly creationClubList: readonly string[];
  /** The archives the INIs list, in load order. */
  readonly archiveList: readonly string[];
  /** Each INI the game reads that the archive list did not. */
  readonly archiveListNotes: readonly string[];
  readonly dataFolderArchives: DataFolderArchives;
  readonly profiles: readonly string[];
  /** Undefined when there is no folder for mods at all. */
  readonly modFolders: ModFolders | undefined;
  /** Each link read as a folder or a file that cannot be followed, left unread, with its path and why. */
  readonly linkNotes: readonly string[];
  /** The files the game wrote at run time. */
  readonly runtimeOutput: OriginFiles;
  /** Each listed mod's own files, by mod name. */
  readonly modFiles: ReadonlyMap<string, OriginFiles>;
  /** Each listed mod's meta by name, and an unlisted mod folder's when downloaded files are there to match against it. */
  readonly folderMeta: ReadonlyMap<string, ModMeta>;
  /** Every repository in the source folder. */
  readonly sourceMods: SourceMods;
  /** Whether the instance folder holds a repository. */
  readonly holdsRepository: boolean;
  /** Whether git init has set the repository up: the instance repository holds Modbench's push check and its path tokens. */
  readonly repositorySetUp: boolean;
  /** Why a folder's watch failed, once per reason: no change inside that folder is heard. */
  readonly watchNotes: readonly string[];
  readonly managerRunning: ManagerRunning;
  readonly publisherConfiguration: PublisherConfiguration;
}

/** The names an entry may not take: the entries mod order lists and the folders mods are in. `modFolders` is undefined
 *  when there is no folder for mods at all. */
export interface TakenNames {
  readonly mods: readonly EntryRef[];
  readonly modFolders: readonly ModFolder[] | undefined;
}

export interface InstanceAdapter {
  /** The whole instance in one generation. A mod order that parses to no entries is read again
   *  after a settle before it is believed: another tool may be half-way through writing it. */
  reading(): Promise<InstanceReading>;
  /** The profile the mod manager's configuration selects now. */
  activeProfile(): Promise<string>;
  /** Mutagen's release of the game the mod manager's configuration selects now. */
  gameRelease(): Promise<string>;
  /** Where the game is now. */
  gameFolder(): Promise<GameFolder>;
  /** Every profile's name. */
  profiles(): Promise<readonly string[]>;
  /** The active profile's mod order and the mod folders, without the rest of the instance. */
  modOrder(): Promise<TakenNames>;
  /** The downloaded files now, without the rest of the instance. */
  downloadedFiles(): Promise<DownloadedFiles>;
  /** The downloaded file `path` names, however the path is spelled; undefined when it names none; or why the downloaded files could not be read. */
  downloadedFileAt(path: string): Promise<FileRead<DownloadedFile | undefined>>;
  /** Every source mod now. */
  sourceMods(): Promise<SourceMods>;
  readonly names: ManagerNames;
  /** Each publisher tag the instance's publisher declares. */
  readonly publisherTags: readonly PublisherTag[];
  /** Adds or removes the publisher tag named `tag` on each path; a path already so changes nothing. Answers the paths it
   *  refused; rejects, writing nothing, for an undeclared tag or a configuration it cannot read. */
  changePublisherTag(change: PublisherTagChange, tag: string, paths: readonly string[]): Promise<readonly PathRefusal[]>;
  /** Why the publisher's configuration cannot be read, or undefined when it can or the instance holds none. */
  publisherConfigurationRefusal(): Promise<string | undefined>;
  /** Moves each publisher tag on or under a mod folder `from` to the same place under `to`, or drops it with no `to`.
   *  Rejects, writing nothing, for a configuration it cannot read. */
  followModFolders(moves: readonly FolderMove[]): Promise<void>;

  // Answers about a mod or a file.
  /** The folder a build of `mod` writes: the one that holds it, else the one its name gives it; undefined when its
   *  name gives none. */
  modFolderPath(mod: string): Promise<string | undefined>;
  /** The source folder init makes a mod's repository in (ADR-0007); undefined when its name gives it none. */
  sourceFolder(mod: string): string | undefined;
  /** The downloaded file the mod manager records `mod` as installed from; undefined when it records none. */
  installationFile(mod: string): Promise<FileRead<InstallationFile | undefined>>;
  /** The downloaded file of `name` in the downloads folder, with its hashes; undefined when the folder holds none of that name. */
  downloadedFile(name: string): Promise<FileRead<InstallationFile | undefined>>;
  /** The file on Nexus a page names, or its mod alone; undefined when it is no Nexus page. */
  nexusFileAt(page: string): NexusPage | undefined;
  /** What Nexus is asked about the downloaded file of `name`; undefined when the downloads folder holds none of that name. */
  downloadedFileQuery(name: string): Promise<FileRead<DownloadedFileQuery | undefined>>;
  /** What the mod manager's metadata says of `mod`'s version and installation file; none when it says none. */
  modMetadata(mod: string): Promise<FileRead<ModMetadata>>;
  /** Where `mod` is on Nexus; none when its metadata holds no Nexus mod ID, unreadable when the metadata cannot say. */
  nexusFile(mod: string): Promise<FileRead<NexusModFile | undefined>>;
  /** Records `version` as the newest version of `mod`, where the mod manager reads it, and says whether the manager now shows an update. Writes nothing when it already holds it. */
  writeNewestVersion(mod: string, version: string): Promise<{ readonly updateAvailable: boolean }>;
  /** What a meta already read says, as `modMetadata` answers it. */
  metadataOf(meta: ModMeta): Promise<ModMetadata>;
  /** Why `metadata` cannot be written into the metadata of `mod`, as a reason; undefined when it can. */
  unwritableMetadata(mod: string, metadata: ModMetadata): Promise<string | undefined>;
  /** Sets the version of `mod` and its installation file, in a metadata made when it has none. Changes only a
   *  value that differs, and gives no file another's source. Rejects, writing nothing, when `unwritableMetadata` says why. */
  writeModMetadata(mod: string, metadata: ModMetadata): Promise<void>;
  /** The files in every mod's folder where the mod manager keeps its metadata, by path in it, which no build makes. */
  readonly metadataFilesInModFolder: readonly string[];
  /** The folder in the instance, outside every mod folder, where mEdit keeps what it last read of each mod's files
   *  (modlist-repository.md, Status, story 3). The repository never commits it. */
  readonly statCacheFolder: string;
  /** The game files in `dataFolder` at the paths of a mod's files, named as the game folder names them, with their hashes.
   *  A path that could not be read is `unreadable` as asked, with why: neither found nor absent. */
  gameFiles(dataFolder: string, modFilePaths: readonly string[]): Promise<GameFilesRead>;
  /** The game files in `dataFolder` at the paths of the files in `mod`'s folder, as `gameFiles` names them, listed in any
   *  profile or none. */
  gameFilesTakenBy(dataFolder: string, mod: string): Promise<FileRead<GameFilesTaken>>;
  /** Writes the instance repository's ignore list: a whitelist of what the repository holds, after the lines of an ignore
   *  list already there. Answers the call that takes back what it wrote. */
  writeIgnoreList(): Promise<() => Promise<void>>;
  /** Makes each source mod with a remote a submodule: its entry in `.gitmodules` and its line in the ignore list. A source mod
   *  it cannot read keeps the entry and line it has. */
  writeSubmodules(): Promise<SubmoduleReport>;
  /** The host of the repository in `sourceFolder`, through `origin`, else its first remote by name. */
  sourceHost(sourceFolder: string): Promise<FileRead<SourceHost>>;
  /** The submodule of the instance repository named `name`, as its index pins it, or what the repository lacks of it. */
  submodule(name: string): Promise<Submodule | { readonly lacks: string }>;
  /** Whether the instance folder holds a repository now, read from disk. */
  repositoryOnDisk(): Promise<boolean>;
  /** Takes back the repository `git init` made. Rejects, removing nothing, when it holds a commit or a ref. */
  removeRepository(): Promise<void>;
  /** Rejects, naming it, when `core.hooksPath` points outside the git directory, or a pre-push hook is where
   *  `refuseUnpublishedPins` would write one. */
  checkPushRefusalFree(): Promise<void>;
  /** Makes the repository refuse a pushed pin its source mod's remote lacks. Rejects when another pre-push hook is
   *  there. Answers the call that removes the hook, if this call wrote it. */
  refuseUnpublishedPins(): Promise<() => Promise<void>>;
  /** Makes git hold each folder's path by a path token, and the working tree this machine's paths. Answers why a path
   *  token stays in the working tree. Writes nothing without a repository. A failed first write is undone. */
  writePathTokens(): Promise<string | undefined>;
  /** Each path no path token names in a file the instance repository holds or would commit. */
  pathsOutsideFolders(): Promise<readonly PathInFile[]>;
  /** The stamp of an origin file, at the path it is read from. */
  fileStamp(path: string): Promise<FileRead<FileStamp>>;
  /** An origin file's size and hash at the path it is read from, remembered for this session alone: its lasting hash
   *  is the stat cache, mEdit's (ADR-0013). Two files with one hash hold the same bytes. */
  originFileHash(path: string): Promise<FileRead<HashedFile>>;

  // Changes.
  /** Every change lands in one write, its folders with it. Naming an entry not there, or adding a
   *  separator that is, rejects all of it. Adding at the winning end an entry there, or dropping
   *  one not there, changes nothing. */
  changeModOrder(profile: string, decide: DecideModOrder): Promise<ModOrderWritten>;
  /** Every change lands in one write. A change naming a plugin that is not there rejects, and
   *  nothing is written. Adding a plugin that is there changes nothing. */
  changePluginOrder(profile: string, decide: DecidePluginOrder): Promise<Written>;
  /** As `changePluginOrder`, with the plugins `profile`'s mod order provides read after the order,
   *  under its lock, the game folder's against one read of the settings. An empty mod order is read
   *  again after a settle. */
  changePluginOrderOverProvided(profile: string, decide: DecidePluginOrderOverProvided): Promise<Written>;
  /** A downloaded file that is gone gets no mark. Rejects when the downloads folder cannot be
   *  resolved. */
  markDownloadedFile(name: string, mark: DownloadedFileMark): Promise<Marked>;
  /** Writes what Nexus names of a downloaded file into its metadata, made when it has none. Keeps every value `info` does not name. Rejects, writing nothing, when the instance's game has no name in Nexus's terms. */
  writeNexusFileInfo(name: string, info: NexusFileInfo): Promise<Marked>;
  /** Puts `bytes` as the downloaded file `name`, with what Nexus names of it in its metadata, when their hash is `hash`, and
   *  puts nothing when it is not. Refuses a name the downloads folder holds, writing nothing. */
  putDownloadedFile(name: string, bytes: AsyncIterable<Uint8Array>, file: { readonly hash: string; readonly info: NexusFileInfo }): Promise<{ readonly put: boolean }>;
  selectProfile(profile: string): Promise<Written>;

  // Put and rename in mods/.
  /** Refuses a folder already there, whatever it holds, matched as the manager matches names. */
  createModFolder(mod: string): Promise<void>;
  /** Renames the folder that holds `from` to `to`, in place. Refuses when none holds `from`, and a
   *  folder already there under another name, matched as the manager matches names. */
  renameModFolder(from: string, to: string): Promise<void>;
  /** The file at `relativePath` as the origin's listing holds it, or `undefined` when none is there.
   *  Rejects a path outside the origin. */
  originFile(origin: FileOrigin, relativePath: string): Promise<OriginFile | undefined>;
  /** Marks a file or folder by its own name; a mark already true changes nothing. Refuses an
   *  include on an unmarked name a folder excludes, and a mark replacing a file. Rejects a path
   *  outside the origin. */
  markOriginFile(origin: FileOrigin, relativePath: string, mark: OriginFileMark): Promise<OriginFileMarked>;
  /** How the manager matches an entry's name; two entries with one key are one name to it. */
  entryKey(entry: EntryRef): string;
  /** The mark the manager reads as excluded. */
  readonly exclusionMark: string;
  /** Whether the origin's folder holds a file of the name now on disk, compared as the game compares plugin names. */
  originHoldsPlugin(origin: FileOrigin, name: string): Promise<boolean>;
  /** Renames plugin `from` of `origin`, its named files and its line in every profile, in one
   *  write; a failed write puts every file back. Refuses, changing nothing, a taken name or a
   *  plugin not there. */
  renamePlugin(origin: FileOrigin, from: string, to: string): Promise<void>;
  /** Moves the folder that holds `entry` out of mods/ into the trash; false when none does. */
  trashEntryFolder(entry: EntryRef, trash: MoveToTrash): Promise<boolean>;
  /** Moves a downloaded file to the trash, then what the manager keeps about it. Rejects when the
   *  file cannot be trashed. `metadataLeftBehind` is the reason what is kept could not follow. */
  trashDownloadedFile(name: string, trash: MoveToTrash): Promise<DownloadedFileTrashed>;
  /** Moves the file at the forward-slash `relativePath` in the mod's folder into the trash; a file already gone is done.
   *  Rejects a path that leaves the folder, its links resolved. */
  trashModFile(mod: string, relativePath: string, trash: MoveToTrash): Promise<void>;
  /** Moves the source folder that builds the mod into the trash; false when none does. */
  trashSourceFolder(mod: string, trash: MoveToTrash): Promise<boolean>;
  /** Puts the package's files, a FOMOD's as `fomod` answers it, in a new folder or the mod's own. Rejects with why; a
   *  new mod's folder goes, and a failed upgrade is not rolled back. */
  install(installed: InstallPackage, target: InstallTarget, keys: InstallKeys, fomod?: FomodAnswer): Promise<InstallOutcome>;

  // Subscribe: the instance changed.
  /** Hears that the instance changed: any of its files, the downloads folder and the game folder's
   *  plugins, where the last read of the settings resolved them. */
  subscribe(listener: () => void): Subscription;
}

/** A file inside `folder`, by the relative path a source tree names it with. */
export const fileInFolder = (folder: string, relativePath: string): string => join(folder, relativePath);

/** The folder beside `mods/` that holds a source mod's repository, each under its mod's name (ADR-0007). */
export const SOURCE_MODS_FOLDER = 'source';

// Matched without case, as Windows matches a name, on every platform alike.
const named = (name: string | undefined, as: string): boolean => name?.toLowerCase() === as;

/** Whether `path` is a file inside a mod's plugin source: `source/<mod>/plugin-source/…`. */
export const isPluginSourcePath = (path: string): boolean => {
  const folders = path.split(/[\\/]/).slice(0, -1);
  return folders.some((name, i) => named(name, PLUGIN_SOURCE_FOLDER) && named(folders[i - 2], SOURCE_MODS_FOLDER));
};

/** A glob that matches `text` as Windows matches a name. A glob matches case, and another tool spells a
 *  plugin's extension or a game's file in any case, so each letter is a class. */
export const anyCase = (text: string): string => text.replace(/./g, (c) => `[${c.toLowerCase()}${c.toUpperCase()}]`);

/** Every file inside a mod's plugin source, as `isPluginSourcePath` takes it. */
export const PLUGIN_SOURCE_GLOB = `**/${anyCase(SOURCE_MODS_FOLDER)}/*/${anyCase(PLUGIN_SOURCE_FOLDER)}/**`;

export interface OriginProvides {
  readonly origin: FileOrigin;
  readonly files: readonly OriginFile[];
}

const provides = (origin: FileOrigin, files: readonly OriginFile[]): OriginProvides =>
  ({ origin, files: files.filter((file) => !file.excluded) });

/** The origins the game gets a file from, winning-first: Overwrite, then each enabled mod in mod
 *  order, each with the files nothing excludes. */
export function filesWinningFirst(
  mods: readonly ModlistEntry[], runtimeOutput: readonly OriginFile[], filesOf: (mod: string) => readonly OriginFile[],
): OriginProvides[] {
  return [
    provides({ kind: 'runtimeOutput' }, runtimeOutput),
    ...mods.flatMap((entry) => (entry.kind === 'mod' && entry.enabled ? [provides({ kind: 'mod', name: entry.name }, filesOf(entry.name))] : [])),
  ];
}

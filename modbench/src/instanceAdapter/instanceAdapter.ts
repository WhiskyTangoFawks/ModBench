// The Instance adapter's interface: a repository over one instance, answering parsed reads and
// taking changes in domain words. A mod manager is one implementation of it; MO2's is
// `mo2Instance.ts`.

import { join } from 'node:path';
import type { PluginEntry } from '../loadOrderFileCodec/pluginsText';
import type { MoveToTrash } from '../ports/trash';

export type { PluginEntry } from '../loadOrderFileCodec/pluginsText';
export { isPluginFile } from './pluginFile';

/** The reserved origin of the files the game wrote at run time (ADR-0012). */
export { OVERWRITE_DIR_NAME as OVERWRITE_ORIGIN } from './codecs/modlistText';

/** The setting that names the game folder outright, and so the one that fixes a folder not found. */
export const GAME_FOLDER_SETTING = 'modbench.mods.gameDirectory';

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

/** The Data folder of a game folder found, undefined when it was not. */
export function dataFolderOf(folder: GameFolder): string | undefined {
  return folder.kind === 'found' ? folder.dataFolder : undefined;
}

/** A file at the root of the Data folder of a game folder found, undefined when it was not. */
export function dataFolderFile(folder: GameFolder, name: string): string | undefined {
  const dataFolder = dataFolderOf(folder);
  return dataFolder === undefined ? undefined : join(dataFolder, name);
}

/** A Nexus mod and file id pair recorded as installed into a mod. */
export interface InstalledFileId {
  modid: string;
  fileid: string;
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
  modid?: string;
  version?: string;
  installationFile?: string;
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

/** One read of the instance's configuration. Both answers come from that same read. */
export interface InstanceSettings {
  readonly profile: string;
  readonly gameName: string;
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
  | { readonly kind: 'dropMod'; readonly mod: string }
  | { readonly kind: 'dropSeparator'; readonly separator: string };

/** Plugin names match as the game matches them, ignoring case (ADR-0012). A plugin added is
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

/** `wrote` is false when the change was already true of the file, which is then left unwritten. */
export interface Written {
  readonly wrote: boolean;
}

export type Marked = { readonly gone: true } | ({ readonly gone: false } & Written);

/** What a subscriber disposes of to hear no more. */
export interface Subscription {
  dispose(): void;
}

/** Where a file's contents come from: a mod, or the files the game wrote at run time. */
export type FileOrigin = { readonly kind: 'mod'; readonly name: string } | { readonly kind: 'runtimeOutput' };

/** One file of an origin, by the relative path the origin's own tree names it with, and where it
 *  is read from. */
export interface OriginFile {
  readonly relativePath: string;
  readonly path: string;
}

/** An origin's files: the origin they take, the folder they are in (none for a name that gives
 *  it none), and each file. `notes` names each entry the listing skipped, one line apiece. */
export interface OriginFiles {
  readonly origin: string;
  readonly folder: string | undefined;
  readonly files: readonly OriginFile[];
  readonly notes: readonly string[];
}

export interface InstanceAdapter {
  // Parsed reads.
  settings(): Promise<InstanceSettings>;
  /** Every profile's name; none when the instance has no profiles. */
  profiles(): Promise<string[]>;
  modOrder(profile: string): Promise<ModlistEntry[]>;
  /** Empty when the mod has no metadata. */
  modMeta(mod: string): Promise<ModMeta>;
  pluginOrder(profile: string): Promise<PluginEntry[]>;
  gameFolderPlugins(gameFolder: GameFolder): Promise<DataFolderPlugins>;

  // Get in mods/.
  /** Undefined when there is no folder for mods at all. A link that cannot be followed is no
   *  folder, and is handed to `skippedLink`. */
  modFolders(skippedLink?: (name: string, reason: string) => void): Promise<ModFolders | undefined>;
  /** The folder that holds `entry`, matched as the manager matches names; undefined when none does. */
  entryFolder(entry: EntryRef): Promise<ModFolder | undefined>;
  /** An origin's files, none when its folder is not there. */
  originFiles(origin: FileOrigin): Promise<OriginFiles>;

  // Changes.
  /** Every change lands in one write, its folders with it. A change naming an entry that is not
   *  there, or adding one that is, rejects, and nothing changes. */
  changeModOrder(profile: string, decide: DecideModOrder): Promise<Written>;
  /** Every change lands in one write. A change naming a plugin that is not there, or adding one
   *  that is, rejects, and nothing is written. */
  changePluginOrder(profile: string, decide: DecidePluginOrder): Promise<Written>;
  /** A downloaded file that is gone gets no mark. Rejects when the downloads folder cannot be
   *  resolved. */
  markDownloadedFile(name: string, mark: DownloadedFileMark): Promise<Marked>;
  /** False when the downloaded file has no metadata. */
  trashDownloadedFileMeta(name: string, trash: MoveToTrash): Promise<boolean>;
  selectProfile(profile: string): Promise<Written>;

  // Put and rename in mods/.
  createModFolder(mod: string): Promise<void>;
  /** Moves the folder that holds `entry` out of mods/ into the trash; false when none does. */
  trashEntryFolder(entry: EntryRef, trash: MoveToTrash): Promise<boolean>;
  /** A fresh folder on the instance's own volume that no watch reaches, for a mod staged before it
   *  lands; the caller removes it. */
  stagingFolder(): Promise<string>;
  /** Writes the staged mod's meta holding `keys` alone, then moves the staged tree into place in
   *  one rename. */
  landNewMod(mod: string, staged: string, keys: OwnedMetaKeys): Promise<void>;
  /** Replaces the folder's contents with the staged tree's around each entry `keep` names, and
   *  sets `keys` over the meta the mod had, keeping each value `keys` leaves undefined. A release
   *  holding a kept entry rejects first. */
  upgradeMod(mod: string, staged: string, keys: OwnedMetaKeys, keep: (entry: string) => boolean): Promise<void>;

  // Subscribe: the instance changed.
  /** Hears that the instance changed: any of its files, the downloads folder and the game folder's
   *  plugins, where the last read of the settings resolved them. */
  subscribe(listener: () => void): Subscription;
}

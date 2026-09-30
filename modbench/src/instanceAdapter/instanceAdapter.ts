// The Instance adapter's interface: a repository over one instance, answering parsed reads and
// taking changes in domain words. A mod manager is one implementation of it; MO2's is
// `mo2Instance.ts`.

import type { PluginEntry } from '../loadOrderFileCodec/pluginsText';
import type { MoveToTrash } from '../ports/trash';
import type { GameFolder } from './gameDirectory';

export type { PluginEntry } from '../loadOrderFileCodec/pluginsText';

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

/** A change to mod order. A mod added is disabled and lands at the winning end; a separator added
 *  is enabled and lands after the entry at `afterIndex`, or before every entry at -1. */
export type ModOrderChange =
  | { readonly kind: 'enable'; readonly mod: string; readonly enabled: boolean }
  | { readonly kind: 'moveMods'; readonly mods: readonly string[]; readonly place: MovePlace; readonly end: OrderEnd }
  | {
    readonly kind: 'moveSeparators';
    readonly separators: readonly string[];
    readonly place: SeparatorsPlace;
    readonly end: OrderEnd;
  }
  | { readonly kind: 'addMod'; readonly mod: string }
  | { readonly kind: 'addSeparator'; readonly separator: string; readonly afterIndex: number }
  | { readonly kind: 'dropMod'; readonly mod: string }
  | { readonly kind: 'dropSeparator'; readonly separator: string };

/** A change to plugin order. A plugin added is disabled and lands at the winning end; a move lands
 *  its plugins, in their own order, at `toIndex` among the plugins that remain. */
export type PluginOrderChange =
  | { readonly kind: 'enable'; readonly plugin: string; readonly enabled: boolean }
  | { readonly kind: 'move'; readonly plugins: readonly string[]; readonly toIndex: number }
  | { readonly kind: 'add'; readonly plugin: string }
  | { readonly kind: 'drop'; readonly plugin: string };

/** A mark on a downloaded file's metadata: a status its metadata claims, or excluded or not. */
export type DownloadedFileMark = 'Installed' | 'Uninstalled' | 'Excluded' | 'Included';

/** Decides the changes from the order as it stands when the change lands. */
export type DecideChanges<Entry, Change> = (order: readonly Entry[]) => readonly Change[] | Promise<readonly Change[]>;

/** `wrote` is false when the change was already true of the file, which is then left unwritten. */
export interface Written {
  readonly wrote: boolean;
}

export interface InstanceAdapter {
  settings(): Promise<InstanceSettings>;
  /** Every profile's name; none when the instance has no profiles. */
  profiles(): Promise<string[]>;
  modOrder(profile: string): Promise<ModlistEntry[]>;
  /** Empty when the mod has no metadata. */
  modMeta(mod: string): Promise<ModMeta>;
  /** Every folder that can hold a mod; undefined when there is no folder for mods at all. A link
   *  that cannot be followed is no folder, and is handed to `skippedLink`. */
  modFolders(skippedLink?: (name: string, reason: string) => void): Promise<string[] | undefined>;
  pluginOrder(profile: string): Promise<PluginEntry[]>;
  gameFolderPlugins(gameFolder: GameFolder): Promise<DataFolderPlugins>;

  /** `decide` runs against the order the changes land on, and every change lands in one write.
   *  A change naming an entry that is not there rejects, and nothing is written. */
  changeModOrder(profile: string, decide: DecideChanges<ModlistEntry, ModOrderChange>): Promise<Written>;
  changePluginOrder(profile: string, decide: DecideChanges<PluginEntry, PluginOrderChange>): Promise<Written>;
  /** A downloaded file that is gone gets no mark. */
  markDownloadedFile(
    downloadsDir: string, name: string, mark: DownloadedFileMark,
  ): Promise<{ readonly gone: true } | ({ readonly gone: false } & Written)>;
  /** False when the downloaded file has no metadata. */
  trashDownloadedFileMeta(downloadsDir: string, name: string, trash: MoveToTrash): Promise<boolean>;
  /** Writes the metadata of the mod folder `folder` whole: `keys` set over the metadata of the mod
   *  folder `carriedFrom`, where a key left undefined keeps that value, or over none. */
  writeModMeta(folder: string, keys: OwnedMetaKeys, carriedFrom?: string): Promise<void>;
  selectProfile(profile: string): Promise<Written>;
}

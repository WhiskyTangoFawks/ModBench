/** A read that answers, or says why it could not. */
export type Read<T> = { readonly kind: 'read'; readonly answer: T } | { readonly kind: 'unreadable'; readonly reason: string };

/** Each header flag of a plugin that changes how the game loads it, by its name, set when true and cleared when false. */
export type PluginFlags = Readonly<Record<string, boolean>>;

/** A file by its path, with its hash. */
export interface HashedPath {
  readonly path: string;
  readonly hash: string;
}

/** A file of a folder: its own path, whether the mod manager excludes it, and its hash. */
export interface FolderFile {
  readonly path: string;
  readonly excluded: boolean;
  readonly read: Read<{ readonly hash: string }>;
}

/** A folder's files by the paths it holds them at, the paths the mod manager excludes, by their own paths, and whether its
 *  file system finds a file by a name in another case. */
export interface FolderValue {
  readonly files: ReadonlyMap<string, FolderFile>;
  readonly exclude: readonly string[];
  readonly ignoresCase: boolean;
}

/** What a status asks the instance for beyond a folder: the downloaded files by name, the paths of the game files the
 *  folder's files may be, and the repository whose host it asks for. */
export interface PackagesAsked {
  readonly installationFiles: readonly string[];
  readonly gameFiles?: readonly string[];
  readonly repository?: string;
}

/** What a clone gets of the repository asked for: `pinned`, a submodule at a commit the instance repository pins or a source folder it
 *  tracks; `unpinned`, a submodule whose commit it does not yet pin; or `none`. */
export type RepositoryPin = 'pinned' | 'unpinned' | 'none';

/** What the status rule reads of a mod besides its manifest, as the Instance adapter hands it; `unreadable` is why a read
 *  rejected, and `notAsked` is that no manifest asked for it. */
export type StatusValues =
  | {
    readonly kind: 'read';
    readonly folder: FolderValue;
    /** Each downloaded file by name, with its entries; undefined when the downloads folder holds none of that name. */
    readonly downloadedFiles: ReadonlyMap<string, Read<{ readonly hash: string; readonly entries: readonly HashedPath[] } | undefined>>;
    /** The game files the folder's files may be, by their paths in the folder; none when the game folder was not found. */
    readonly gameFiles: readonly HashedPath[] | undefined;
    readonly repositoryPin: RepositoryPin;
  }
  | { readonly kind: 'unreadable'; readonly reason: string }
  | { readonly kind: 'notAsked' };

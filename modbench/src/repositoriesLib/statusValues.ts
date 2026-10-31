/** A read that answers, or says why it could not. */
export type Read<T> = { readonly kind: 'read'; readonly answer: T } | { readonly kind: 'unreadable'; readonly reason: string };

/** The version and installation file a mod's metadata holds. */
export interface HeldMetadata {
  readonly version?: string;
  readonly installationFile?: { readonly name: string; readonly page?: string };
}

/** A folder's files by path, each with its hash, and whether its file system finds a file by a name in another case. */
export interface FolderValue {
  readonly files: ReadonlyMap<string, Read<{ readonly hash: string }>>;
  readonly ignoresCase: boolean;
}

/** Each package's entries, each path's hash, by the hash that names the package, or the repository's name. */
export type PackageEntries = ReadonlyMap<string, ReadonlyMap<string, string>>;

/** What a status asks the instance for beyond a folder: the package entries by the key that names each package, and the downloaded files by name. */
export interface PackagesAsked {
  readonly entries: readonly string[];
  readonly installationFiles: readonly string[];
}

/** What the status rule reads of a mod besides its manifest, as the Instance adapter hands it; `unreadable` is why a read rejected, and `metadataOnly` is that the folder was not asked for. */
export type StatusValues = { readonly metadata: Read<HeldMetadata> } & (
  | {
    readonly kind: 'read';
    readonly folder: FolderValue;
    readonly packageEntries: PackageEntries;
    readonly downloadedFiles: ReadonlyMap<string, Read<{ readonly hash: string } | undefined>>;
    readonly gameFolder: { readonly kind: 'found' | 'notFound' };
  }
  | { readonly kind: 'unreadable'; readonly reason: string }
  | { readonly kind: 'metadataOnly' }
);

// spec/formats/manifest.md, version 1: the manifest as its schema states it.

export interface NexusFile {
  readonly game: string;
  readonly mod: number;
  readonly file: number;
}

interface SteamApp {
  readonly app: number;
  /** Each depot's version, by its depot ID. */
  readonly depots?: Readonly<Record<string, string>>;
}

export type ManifestPackage =
  | { readonly kind: 'installationFile'; readonly name: string; readonly size: number; readonly hash: string; readonly host?: { readonly nexus: NexusFile } }
  | { readonly kind: 'gameFolder'; readonly host?: { readonly steam: SteamApp } }
  | { readonly kind: 'repository'; readonly name: string };

export interface Manifest {
  readonly packages: readonly ManifestPackage[];
  readonly exclude: readonly string[];
  /** Each file by its path, with its hash; null for a file a build step makes. */
  readonly files: ReadonlyMap<string, string | null>;
}

/** `olderFormat`: the text is a manifest of the format before version 1, which names no version and update manifest writes
 *  over (pre-alpha: no migration). */
export type ManifestRead = { readonly manifest: Manifest } | { readonly refused: string; readonly olderFormat?: true };

export const MANIFEST_VERSION = 1;

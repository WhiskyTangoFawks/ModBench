export type ManifestPackage =
  | { readonly kind: 'installationFile'; readonly name: string; readonly size: number; readonly hash: string; readonly page?: string }
  | { readonly kind: 'gameFolder'; readonly name: string; readonly hash: string; readonly depots: readonly GameDepot[] }
  | { readonly kind: 'sourceRepository'; readonly name: string; readonly isSubmodule: boolean };

export interface GameDepot {
  readonly id: string;
  readonly version: string;
}

export type PackageEntry =
  | { readonly kind: 'held' }
  | { readonly kind: 'heldAt'; readonly path: string }
  | { readonly kind: 'notHeld' }
  | { readonly kind: 'otherBytes' }
  | { readonly kind: 'madeByStep' };

/** `hash`: the bytes a source mod's build vouches for, recorded in the line itself. */
export interface ManifestFile {
  readonly path: string;
  readonly entry: PackageEntry;
  readonly package?: string;
  readonly hash?: string;
}

export interface ManifestStep {
  readonly task: string;
  readonly args: readonly string[];
}

export interface ManifestTool {
  readonly task: string;
  readonly page: string;
}

export interface ManifestArchive {
  readonly path: string;
  readonly files: readonly string[];
}

/** `installationFile`: the name of the package the mod's metadata names as what the mod was installed from. */
export interface Manifest {
  readonly packages: readonly ManifestPackage[];
  readonly version?: string;
  readonly installationFile?: string;
  readonly exclude: readonly string[];
  readonly archives: readonly ManifestArchive[];
  readonly files: readonly ManifestFile[];
}

export type BuildFile = Manifest & { readonly steps: readonly ManifestStep[]; readonly tools: readonly ManifestTool[] };

export type ManifestRead = { readonly manifest: Manifest } | { readonly refused: string };

export type BuildFileRead = { readonly buildFile: BuildFile } | { readonly refused: string };

export type BuildFilePackage =
  | { readonly kind: 'installationFile'; readonly name: string; readonly size: number; readonly hash: string; readonly page?: string }
  | { readonly kind: 'gameFolder'; readonly name: string; readonly hash: string; readonly depots: readonly GameDepot[] };

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

export interface BuildFileLine {
  readonly path: string;
  readonly entry: PackageEntry;
  readonly package?: string;
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

export interface BuildFile {
  readonly packages: readonly BuildFilePackage[];
  readonly archives: readonly ManifestArchive[];
  readonly steps: readonly ManifestStep[];
  readonly tools: readonly ManifestTool[];
  readonly files: readonly BuildFileLine[];
}

export type BuildFileRead = { readonly buildFile: BuildFile } | { readonly refused: string };

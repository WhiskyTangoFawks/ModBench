interface GitApi {
  /** Resolves null when git declined. */
  init(root: unknown): PromiseLike<unknown>;
}
export interface GitExtensionExports {
  getAPI(version: 1): GitApi;
}

/** VS Code's git, as the host hands it over. The host's git belongs to the host, so the composition root implements it. */
export interface HostGit {
  extension(): { readonly isActive: boolean; readonly exports: GitExtensionExports; activate(): PromiseLike<GitExtensionExports> } | undefined;
  folderUri(folder: string): unknown;
}

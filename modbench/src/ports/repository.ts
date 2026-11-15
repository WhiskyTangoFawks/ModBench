type HostEvent<T> = (listener: (value: T) => unknown) => { dispose(): unknown };

/** The members of VS Code's git API (`extensions/git/src/api/git.d.ts`) Modbench reads. */
export interface HostGitRepository<Folder> {
  readonly rootUri: Folder;
  readonly state: { readonly HEAD: { readonly commit?: string } | undefined; readonly onDidChange: HostEvent<void> };
  /** The repository's own value of `key`, '' where it has none. */
  getConfig(key: string): PromiseLike<string>;
  /** Runs git status, so `state` shows the disk as it is now. */
  status(): PromiseLike<void>;
}

export interface HostGitApi<Folder> {
  init(folder: Folder): PromiseLike<unknown>;
  getRepository(folder: Folder): HostGitRepository<Folder> | null;
  readonly onDidOpenRepository: HostEvent<HostGitRepository<Folder>>;
  readonly onDidCloseRepository: HostEvent<HostGitRepository<Folder>>;
}

export interface HostGit<Folder> {
  /** `getAPI` throws while git is disabled. */
  extension(): { activate(): PromiseLike<{ getAPI(version: 1): HostGitApi<Folder> }> } | undefined;
  folderOf(path: string): Folder;
  pathOf(folder: Folder): string;
}

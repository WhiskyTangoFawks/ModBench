export interface HostGit<Folder> {
  extension(): { activate(): PromiseLike<{ getAPI(version: 1): { init(folder: Folder): PromiseLike<unknown> } }> } | undefined;
  folderOf(path: string): Folder;
}

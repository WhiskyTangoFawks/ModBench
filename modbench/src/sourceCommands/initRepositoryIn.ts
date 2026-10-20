import type { HostGit } from '../ports/repository';

export async function initRepositoryIn<Folder>(host: HostGit<Folder>, folder: string): Promise<void> {
  const extension = host.extension();
  if (extension === undefined) throw new Error("VS Code's git extension is not available.");
  const git = await extension.activate();
  if (await git.getAPI(1).init(host.folderOf(folder)) === null) throw new Error(`VS Code's git did not make ${folder} a repository.`);
}

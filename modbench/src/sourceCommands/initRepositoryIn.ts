import type { HostGit } from '../ports/repository';

/** Makes `folder` a repository through VS Code's git, which Source Control then shows. */
export async function initRepositoryIn(host: HostGit, folder: string): Promise<void> {
  const extension = host.extension();
  if (extension === undefined) throw new Error("VS Code's git extension is not available.");
  const exports = extension.isActive ? extension.exports : await extension.activate();
  if (await exports.getAPI(1).init(host.folderUri(folder)) === null) throw new Error(`VS Code's git did not make ${folder} a repository.`);
}

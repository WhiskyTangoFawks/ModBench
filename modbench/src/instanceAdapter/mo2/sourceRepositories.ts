import { join } from 'node:path';
import { ignoreSkippedLink, isRepository, listFolders, readOrAbsent } from '../files';
import { sourceRootDir } from './layout';

/** Each repository in the source folder, its folder by its name. */
export async function sourceRepositoriesIn(instanceRoot: string): Promise<ReadonlyMap<string, string>> {
  const root = sourceRootDir(instanceRoot);
  const repositories = new Map<string, string>();
  for (const name of (await readOrAbsent(() => listFolders(root, ignoreSkippedLink), [])).sort()) {
    if (await isRepository(join(root, name))) repositories.set(name, join(root, name));
  }
  return repositories;
}

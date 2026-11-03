import { join } from 'node:path';
import { exists, ignoreSkippedLink, isRepository, listFolders, readOrAbsent } from '../files';
import { BUILD_FILE } from '../../wire/sourceMod';
import { sourceRootDir } from './layout';

/** Each source mod's folder in the source folder, by its name: a repository, or a folder the modlist repository holds,
 *  which holds its build file. */
export async function sourceRepositoriesIn(instanceRoot: string): Promise<ReadonlyMap<string, string>> {
  const root = sourceRootDir(instanceRoot);
  const repositories = new Map<string, string>();
  for (const name of (await readOrAbsent(() => listFolders(root, ignoreSkippedLink), [])).sort()) {
    const folder = join(root, name);
    if (await isRepository(folder) || await exists(join(folder, BUILD_FILE))) repositories.set(name, folder);
  }
  return repositories;
}

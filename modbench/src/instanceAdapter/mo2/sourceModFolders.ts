import { join } from 'node:path';
import { exists, ignoreSkippedLink, isRepository, listFolders, readOrAbsent } from '../files';
import { git } from '../git';
import { keptByIndex } from '../keptByIndex';
import { BUILD_FILE } from '../../wire/sourceMod';
import { sourceModPath, sourceRootDir } from './layout';

const keptTracked = keptByIndex<ReadonlySet<string>>();

/** The source folders of `names` whose build file the instance repository's index holds. */
export async function sourceFoldersTracked(instanceRoot: string, names: readonly string[]): Promise<ReadonlySet<string>> {
  if (names.length === 0 || !(await isRepository(instanceRoot))) return new Set();
  const buildFileOf = (name: string): string => `${sourceModPath(name)}/${BUILD_FILE}`;
  return keptTracked(instanceRoot, names.join('\0'), async () => {
    const listed = await git(instanceRoot, 'ls-files', '-z', '--', ...names.map((name) => `:(literal)${buildFileOf(name)}`));
    const tracked = new Set(listed.split('\0'));
    return new Set(names.filter((name) => tracked.has(buildFileOf(name))));
  });
}

/** Each source mod's folder in the source folder, by its name: one that holds its build file, and either a repository of
 *  its own or none, its build file in the instance repository's index. */
export async function sourceModFoldersIn(instanceRoot: string): Promise<ReadonlyMap<string, string>> {
  const root = sourceRootDir(instanceRoot);
  const withBuildFile: { readonly name: string; readonly own: boolean }[] = [];
  for (const name of (await readOrAbsent(() => listFolders(root, ignoreSkippedLink), [])).sort()) {
    const folder = join(root, name);
    if (await exists(join(folder, BUILD_FILE))) withBuildFile.push({ name, own: await isRepository(folder) });
  }
  const tracked = await sourceFoldersTracked(instanceRoot, withBuildFile.filter(({ own }) => !own).map(({ name }) => name));
  return new Map(withBuildFile.filter(({ name, own }) => own || tracked.has(name)).map(({ name }) => [name, join(root, name)]));
}

import { isRepository } from './files';
import { foldersInReach, gitPath, splitNul } from './foldersHeldWhole';
import { git } from './git';

const listedIn = async (repository: string): Promise<string[]> =>
  splitNul(await git(repository, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'));

/** The files git holds in each of `folders`, by path in it: one it tracks, or a new one it does not ignore. A folder that
 *  is a repository answers for itself; the instance repository holds none outside its reach. */
export async function filesHeldByGit(instanceRoot: string, folders: readonly string[]): Promise<ReadonlyMap<string, readonly string[]>> {
  const held = new Map<string, readonly string[]>();
  const inInstance: string[] = [];
  for (const folder of folders) {
    if (await isRepository(folder)) held.set(folder, await listedIn(folder));
    else inInstance.push(folder);
  }
  const reachable = await isRepository(instanceRoot) ? await foldersInReach(instanceRoot, inInstance) : [];
  const listed = reachable.length === 0 ? [] : await listedIn(instanceRoot);
  for (const folder of inInstance) {
    const prefix = `${gitPath(instanceRoot, folder)}/`;
    held.set(folder, reachable.includes(folder) ? listed.flatMap((path) => (path.startsWith(prefix) ? [path.slice(prefix.length)] : [])) : []);
  }
  return held;
}

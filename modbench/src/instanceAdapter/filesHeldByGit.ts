import { isRepository } from './files';
import { foldersInReach, gitPath, splitNul } from './foldersHeldWhole';
import { treeStampsOf } from './folderTreeStamps';
import { git } from './git';
import { keptByRepositoryState } from './keptByRepositoryState';

const listedIn = async (repository: string): Promise<string[]> =>
  splitNul(await git(repository, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'));

const keptListings = keptByRepositoryState<string[]>();

async function keptListing(repository: string, root: string, folders: readonly string[]): Promise<string[]> {
  const tree = await treeStampsOf(root, folders);
  if (tree === undefined) return listedIn(repository);
  return keptListings(repository, 'listed', () => listedIn(repository), [folders.join('\0'), tree]);
}

// Each listed path goes to the folder whose path in the repository it lies under, by its path in that folder.
function sortedInto(inInstance: readonly string[], instanceRoot: string, listed: readonly string[]): Map<string, string[]> {
  const byPrefix = new Map(inInstance.map((folder) => [gitPath(instanceRoot, folder), folder] as const));
  const files = new Map(inInstance.map((folder) => [folder, [] as string[]] as const));
  for (const path of listed) {
    for (let slash = path.indexOf('/'); slash !== -1; slash = path.indexOf('/', slash + 1)) {
      const folder = byPrefix.get(path.slice(0, slash));
      if (folder !== undefined) files.get(folder)?.push(path.slice(slash + 1));
    }
  }
  return files;
}

/** The files git holds in each of `folders`, by path in it: one it tracks, or a new one it does not ignore. A folder that
 *  is a repository answers for itself; the instance repository holds none outside its reach. */
export async function filesHeldByGit(instanceRoot: string, folders: readonly string[]): Promise<ReadonlyMap<string, readonly string[]>> {
  const held = new Map<string, readonly string[]>();
  const inInstance: string[] = [];
  for (const folder of folders) {
    if (await isRepository(folder)) held.set(folder, await keptListing(folder, folder, [folder]));
    else inInstance.push(folder);
  }
  const reachable = await isRepository(instanceRoot) ? await foldersInReach(instanceRoot, inInstance) : [];
  const listed = reachable.length === 0 ? [] : await keptListing(instanceRoot, instanceRoot, reachable);
  const sorted = sortedInto(reachable, instanceRoot, listed);
  for (const folder of inInstance) held.set(folder, sorted.get(folder) ?? []);
  return held;
}

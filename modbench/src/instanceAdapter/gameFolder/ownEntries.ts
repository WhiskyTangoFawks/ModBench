import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { keptUntilNamed, listDirByStamp, type ResolvedEntry } from '../files';

/** Hands over a link in the game folder, by its path. */
export type IgnoredLink = (linkPath: string) => void;

export const ignoreLink: IgnoredLink = () => undefined;

// A new hard link changes neither a file's stamp nor its folder's, so what is linked is kept until a change names the folder.
const ownAndLinkedIn = keptUntilNamed(async (path: string): Promise<{ own: ResolvedEntry[]; linked: string[] }> => {
  const listing = await listDirByStamp(path);
  const isLinked = await Promise.all(listing.map(async (dirent) => dirent.isSymbolicLink() || (dirent.isFile() && (await lstat(join(path, dirent.name))).nlink > 1)));
  return {
    own: listing.filter((_dirent, at) => !isLinked[at]).map((dirent) => ({ name: dirent.name, isFile: dirent.isFile(), isDirectory: dirent.isDirectory() })),
    linked: listing.filter((_dirent, at) => isLinked[at]).map((dirent) => join(path, dirent.name)),
  };
});

/** The entries directly in a game folder's `path` that are the game's own. A link is a deployed file,
 *  so a symlink, or a file with more than one hard link, is handed to `ignoredLink` and left out. */
export async function listOwnEntries(path: string, ignoredLink: IgnoredLink): Promise<ResolvedEntry[]> {
  const { own, linked } = await ownAndLinkedIn(path);
  for (const link of linked) ignoredLink(link);
  return own;
}

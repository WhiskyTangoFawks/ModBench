import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { listDirByStamp, readOrAbsent, type ResolvedEntry } from '../files';

/** Hands over a link in the game folder, by its path. */
export type IgnoredLink = (linkPath: string) => void;

export const ignoreLink: IgnoredLink = () => undefined;

/** The entries directly in a game folder's `path` that are the game's own. A link is a deployed file,
 *  so a symlink, or a file with more than one hard link, is handed to `ignoredLink` and left out. */
export async function listOwnEntries(path: string, ignoredLink: IgnoredLink): Promise<ResolvedEntry[]> {
  const entries = await Promise.all((await listDirByStamp(path)).map(async (dirent): Promise<ResolvedEntry | undefined> => {
    const { name } = dirent;
    const linked = dirent.isSymbolicLink() || (dirent.isFile() && (await lstat(join(path, name))).nlink > 1);
    if (linked) {
      ignoredLink(join(path, name));
      return undefined;
    }
    return { name, isFile: dirent.isFile(), isDirectory: dirent.isDirectory() };
  }));
  return entries.filter((entry): entry is ResolvedEntry => entry !== undefined);
}

/** Whether the file at `path` in a game folder is there and the game's own, a link being a deployed file. */
export async function isOwnFile(path: string): Promise<boolean> {
  const stats = await readOrAbsent(() => lstat(path), undefined);
  return stats !== undefined && stats.isFile() && stats.nlink === 1;
}

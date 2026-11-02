import { relative, sep } from 'node:path';
import { isRepository } from './files';
import { git } from './git';

/** The `folders` of the instance that git holds whole: none of their files is one git ignores and does not track. None while
 *  the instance holds no repository. Rejects when git cannot list the instance. */
export async function foldersHeldWhole(instanceRoot: string, folders: readonly string[]): Promise<ReadonlySet<string>> {
  if (!await isRepository(instanceRoot)) return new Set();
  const listed = await git(instanceRoot, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z');
  const ignored = listed.split('\0').filter((path) => path !== '');
  const isLeftOut = (folder: string): boolean => {
    const inside = `${relative(instanceRoot, folder).split(sep).join('/')}/`;
    return ignored.some((path) => path.startsWith(inside) || inside.startsWith(path.endsWith('/') ? path : `${path}/`));
  };
  return new Set(folders.filter((folder) => !isLeftOut(folder)));
}

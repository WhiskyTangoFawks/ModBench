import { isAbsolute, relative, sep } from 'node:path';
import { isRepository } from './files';
import { git } from './git';

const isInside = (instanceRoot: string, folder: string): boolean => {
  const inInstance = relative(instanceRoot, folder);
  return inInstance !== '' && inInstance !== '..' && !inInstance.startsWith(`..${sep}`) && !isAbsolute(inInstance);
};

export async function foldersHeldWhole(instanceRoot: string, folders: readonly string[]): Promise<ReadonlySet<string>> {
  if (!await isRepository(instanceRoot)) return new Set();
  const listed = await git(instanceRoot, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z');
  const ignored = listed.split('\0').filter((path) => path !== '');
  const isLeftOut = (folder: string): boolean => {
    const inside = `${relative(instanceRoot, folder).split(sep).join('/')}/`;
    return ignored.some((path) => path.startsWith(inside) || inside.startsWith(path.endsWith('/') ? path : `${path}/`));
  };
  return new Set(folders.filter((folder) => isInside(instanceRoot, folder) && !isLeftOut(folder)));
}

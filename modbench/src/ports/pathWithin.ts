import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { errnoCode } from './errno';

async function realPathOf(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch (err) {
    if (errnoCode(err) !== 'ENOENT' && errnoCode(err) !== 'ENOTDIR') throw err;
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(await realPathOf(parent), basename(absolute));
  }
}

/** Whether `path` is `folder` or below it, links resolved. */
export async function isWithin(folder: string, path: string): Promise<boolean> {
  const below = relative(await realPathOf(folder), await realPathOf(path));
  return below !== '..' && !below.startsWith(`..${sep}`) && !isAbsolute(below);
}

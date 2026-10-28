import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { readOrAbsent } from '../files';

async function realPathOf(path: string): Promise<string> {
  const absolute = resolve(path);
  const parent = dirname(absolute);
  return readOrAbsent(() => realpath(absolute), undefined).then(async (real) => real ?? (parent === absolute ? absolute : join(await realPathOf(parent), basename(absolute))));
}

/** Whether `path` is `folder` or below it, links resolved. */
export async function isWithin(folder: string, path: string): Promise<boolean> {
  const below = relative(await realPathOf(folder), await realPathOf(path));
  return below !== '..' && !below.startsWith(`..${sep}`) && !isAbsolute(below);
}

/** The game folder's root when `folder` is, holds or sits inside it. */
export async function overlappedGameRoot(game: { readonly kind: string; readonly root?: string }, folder: string): Promise<string | undefined> {
  const { root } = game;
  return game.kind === 'found' && root !== undefined && (await isWithin(folder, root) || await isWithin(root, folder)) ? root : undefined;
}

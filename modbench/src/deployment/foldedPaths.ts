// The game matches a name without case, on Linux too through Wine, so a path deploy writes takes the
// casing of the folder or file the deployment folder already holds, or that deploy writes first.

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { errnoCode } from '../ports/errno';

export const fold = (path: string): string => path.toLowerCase();

async function namesIn(folder: string): Promise<Map<string, string>> {
  try {
    return new Map((await readdir(folder)).map((name) => [fold(name), name]));
  } catch (err) {
    const code = errnoCode(err);
    if (code === 'ENOENT' || code === 'ENOTDIR') return new Map();
    throw err;
  }
}

/** Answers a `/`-separated path below `root` in the casing `root` holds, and claims each name it
 *  does not hold, so the next path that names it folds to it. */
export function foldedPathsBelow(root: string) {
  const held = new Map<string, Promise<Map<string, string>>>();
  const heldIn = (below: string): Promise<Map<string, string>> => {
    const known = held.get(below);
    if (known !== undefined) return known;
    const read = namesIn(join(root, below));
    held.set(below, read);
    return read;
  };
  return async (path: string): Promise<string> => {
    let folded = '';
    for (const name of path.split('/')) {
      const names = await heldIn(folded);
      const holds = names.get(fold(name));
      if (holds === undefined) names.set(fold(name), name);
      folded = folded === '' ? holds ?? name : `${folded}/${holds ?? name}`;
    }
    return folded;
  };
}

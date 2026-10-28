// commands.md: "A failed gesture writes nothing." Each change deploy makes in the deployment folder is
// undone when a later one fails, and a file it removes is set aside until the deploy lands.

import { link, lstat, mkdir, readdir, rmdir, unlink } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import { errnoCode } from '../ports/errno';
import { errorMessage } from '../ports/errorMessage';
import type { Written } from './record';

export interface Link extends Written {
  readonly source: string;
}

/** A change outside the deployment folder: it makes itself and answers how to undo itself, or undoes what it did and throws. */
export type Step = () => Promise<Undo>;

export interface Changes {
  readonly removals: readonly Written[];
  readonly relinks: readonly Link[];
  readonly links: readonly Link[];
}

export interface Undo {
  readonly left: string;
  readonly run: () => Promise<void>;
}

const ASIDE = '.modbench_aside_';

const missing = (err: unknown): boolean => {
  const code = errnoCode(err);
  return code === 'ENOENT' || code === 'ENOTDIR';
};

export async function fileIdAt(path: string): Promise<string | undefined> {
  try {
    return String((await lstat(path, { bigint: true })).ino);
  } catch (err) {
    if (missing(err)) return undefined;
    throw err;
  }
}

// A link fails where a file is, so neither move replaces a file deploy does not own.
async function moved(from: string, to: string): Promise<void> {
  await link(from, to);
  try {
    await unlink(from);
  } catch (err) {
    await unlink(to);
    throw err;
  }
}

async function setAside(at: string): Promise<string> {
  for (let n = 0; ; n++) {
    const aside = `${at}${ASIDE}${process.pid}_${n}`;
    try {
      await moved(at, aside);
      return aside;
    } catch (err) {
      if (errnoCode(err) !== 'EEXIST') throw err;
    }
  }
}

/** Puts back, or removes, each file a deploy set aside from a path the record names, this deploy's
 *  or one killed mid-write (ADR-0003), and answers the file ID the path then holds. */
export function recoveryIn() {
  const names = new Map<string, Promise<string[]>>();
  const asidesIn = (folder: string): Promise<string[]> => {
    const known = names.get(folder);
    if (known !== undefined) return known;
    const read = readdir(folder).then((all) => all.filter((name) => name.includes(ASIDE)), (err: unknown) => {
      if (missing(err)) return [];
      throw err;
    });
    names.set(folder, read);
    return read;
  };
  return async (at: string, { ino }: Written): Promise<string | undefined> => {
    let id = await fileIdAt(at);
    for (const name of await asidesIn(dirname(at))) {
      const aside = join(dirname(at), name);
      if (!name.startsWith(`${basename(at)}${ASIDE}`) || await fileIdAt(aside) !== ino) continue;
      if (id === undefined) {
        await moved(aside, at);
        id = ino;
      } else await unlink(aside);
    }
    return id;
  };
}

export async function removeFolders(from: string, upTo: string): Promise<void> {
  for (let folder = from; ; folder = dirname(folder)) {
    await rmdir(folder);
    if (folder === upTo) return;
  }
}

async function undoAll(undos: readonly Undo[]): Promise<string[]> {
  const left: string[] = [];
  for (const undo of [...undos].reverse()) {
    try {
      await undo.run();
    } catch (err) {
      left.push(`${undo.left} (${errorMessage(err)})`);
    }
  }
  return left;
}

async function removedAside(folder: string, asides: readonly string[]): Promise<string[]> {
  const left: string[] = [];
  for (const aside of asides) {
    try {
      await unlink(aside);
    } catch (err) {
      left.push(`${relative(folder, aside).split(sep).join('/')} (${errorMessage(err)})`);
    }
  }
  return left;
}

/** Makes every change and `steps`, then `land`s them, and answers each file it set aside and could not remove;
 *  or, when one fails, undoes the rest and throws why, naming each change it could not undo. */
export async function changeAll(folder: string, { removals, relinks, links }: Changes, steps: readonly Step[], land: () => Promise<void>): Promise<string[]> {
  const undos: Undo[] = [];
  const asides: string[] = [];
  try {
    for (const { path } of [...removals, ...relinks]) {
      const at = join(folder, path);
      const aside = await setAside(at);
      asides.push(aside);
      undos.push({ left: `${path}, set aside as ${basename(aside)}`, run: () => moved(aside, at) });
    }
    for (const { path, source } of [...relinks, ...links]) {
      const at = join(folder, path);
      const created = await mkdir(dirname(at), { recursive: true });
      if (created !== undefined) undos.push({ left: `${relative(folder, created)}, a folder deploy made`, run: () => removeFolders(dirname(at), created) });
      await link(source, at);
      undos.push({ left: `${path}, which deploy linked`, run: () => unlink(at) });
    }
    for (const step of steps) undos.push(await step());
    await land();
  } catch (err) {
    const left = await undoAll(undos);
    throw new Error(left.length === 0 ? errorMessage(err) : `${errorMessage(err)}. Deploy could not undo: ${left.join('; ')}`);
  }
  return removedAside(folder, asides);
}

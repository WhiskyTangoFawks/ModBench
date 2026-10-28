// commands.md: "A failed gesture writes nothing." Each change deploy makes in the deployment folder is
// undone when a later one fails, and a file it removes is set aside until the deploy lands.

import { link, mkdir, rename, rmdir, unlink } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { errorMessage } from '../ports/errorMessage';
import type { Written } from './record';

export interface Link extends Written {
  readonly source: string;
}

export interface Changes {
  readonly removals: readonly Written[];
  readonly relinks: readonly Link[];
  readonly links: readonly Link[];
}

interface Undo {
  readonly left: string;
  readonly run: () => Promise<void>;
}

const asideOf = (at: string): string => `${at}.modbench_aside_${process.pid}`;

async function removeFolders(from: string, upTo: string): Promise<void> {
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

/** Makes every change, then `land`s them; or, when one fails, undoes the rest and throws why, naming
 *  each change it could not undo. */
export async function changeAll(folder: string, { removals, relinks, links }: Changes, land: () => Promise<void>): Promise<void> {
  const undos: Undo[] = [];
  try {
    for (const { path } of [...removals, ...relinks]) {
      const at = join(folder, path);
      await rename(at, asideOf(at));
      undos.push({ left: `${path}, set aside as ${basename(asideOf(at))}`, run: () => rename(asideOf(at), at) });
    }
    for (const { path, source } of [...relinks, ...links]) {
      const at = join(folder, path);
      const created = await mkdir(dirname(at), { recursive: true });
      if (created !== undefined) undos.push({ left: `${relative(folder, created)}, a folder deploy made`, run: () => removeFolders(dirname(at), created) });
      await link(source, at);
      undos.push({ left: `${path}, which deploy linked`, run: () => unlink(at) });
    }
    await land();
  } catch (err) {
    const left = await undoAll(undos);
    throw new Error(left.length === 0 ? errorMessage(err) : `${errorMessage(err)}. Deploy could not undo: ${left.join('; ')}`);
  }
  for (const { path } of [...removals, ...relinks]) await unlink(asideOf(join(folder, path)));
}

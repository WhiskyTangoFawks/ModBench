// mEdit's and a step's writes have no trash, so the old copy waits beside its file. The trash restores a file to the path
// it was trashed from, so the old copy goes back there first.

import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { errnoCode } from '../ports/errno';
import { errorMessage } from '../ports/errorMessage';
import type { MoveToTrash } from '../ports/trash';
import { exists, ownTempPrefix, remove, rename, sameBytes } from './files';
import type { InstanceAdapter } from './instanceAdapter';

interface Kept {
  readonly path: string;
  readonly file: string;
  readonly copy: string;
}

type NotTrashed = Awaited<ReturnType<InstanceAdapter['trashingReplaced']>>['notTrashed'][number];

// Named with no extension of its own, so a step's tool that globs a kind of file passes it by.
const tempBeside = (file: string, kind: string): string => `${ownTempPrefix(dirname(file), kind)}_${randomUUID()}`;

async function keptCopies(folder: string, paths: readonly string[]): Promise<Kept[]> {
  const kept: Kept[] = [];
  try {
    for (const path of paths) {
      const file = join(folder, path);
      const copy = tempBeside(file, 'replaced');
      try {
        await copyFile(file, copy, constants.COPYFILE_FICLONE);
      } catch (err) {
        if (errnoCode(err) === 'ENOENT') continue;
        throw err;
      }
      kept.push({ path, file, copy });
    }
  } catch (err) {
    await Promise.all(kept.map(({ copy }) => remove(copy)));
    throw err;
  }
  return kept;
}

async function oldCopyTrashed({ path, file, copy }: Kept, trash: MoveToTrash): Promise<NotTrashed | undefined> {
  if (await exists(file) && await sameBytes(file, copy)) {
    await remove(copy);
    return undefined;
  }
  const written = await exists(file) ? tempBeside(file, 'replacing') : undefined;
  try {
    if (written !== undefined) await rename(file, written);
    await rename(copy, file);
    await trash(file);
  } catch (err) {
    if (written !== undefined) await remove(written);
    return { path, why: `'${path}' could not be moved to the trash: ${errorMessage(err)}` };
  }
  if (written !== undefined) await rename(written, file);
  return undefined;
}

/** `InstanceAdapter.trashingReplaced`, over the files on disk. */
export async function trashingReplaced<T>(
  folder: string, paths: readonly string[], trash: MoveToTrash, write: () => Promise<T>,
): Promise<{ readonly answer: T; readonly notTrashed: readonly NotTrashed[] }> {
  const kept = await keptCopies(folder, paths);
  const settled = async (): Promise<NotTrashed[]> => {
    const notTrashed: NotTrashed[] = [];
    for (const one of kept) {
      const why = await oldCopyTrashed(one, trash);
      if (why !== undefined) notTrashed.push(why);
    }
    return notTrashed;
  };
  let answer: T;
  try {
    answer = await write();
  } catch (err) {
    await settled();
    throw err;
  }
  return { answer, notTrashed: await settled() };
}

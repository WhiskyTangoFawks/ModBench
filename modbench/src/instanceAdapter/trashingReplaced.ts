// mEdit's and a step's writes have no trash, so each file they may replace is trashed first. The trash restores a file
// to the path it left, so the file itself goes, and a copy takes its place.

import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { errnoCode } from '../ports/errno';
import { errorMessage } from '../ports/errorMessage';
import type { MoveToTrash } from '../ports/trash';
import { remove, rename } from './files';
import { ownTempPrefix } from '../repositoriesLib/wholeWrites';

async function whyNotTrashed(folder: string, path: string, trash: MoveToTrash): Promise<string | undefined> {
  const file = join(folder, path);
  const copy = `${ownTempPrefix(dirname(file), 'kept')}_${randomUUID()}`;
  try {
    await copyFile(file, copy, constants.COPYFILE_FICLONE);
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return undefined;
    throw err;
  }
  try {
    await trash(file);
  } catch (err) {
    await remove(copy);
    return `'${path}' could not be moved to the trash: ${errorMessage(err)}`;
  }
  await rename(copy, file);
  return undefined;
}

/** `InstanceAdapter.trashingReplaced`, over the files on disk. */
export async function trashingReplaced<T>(
  folder: string, paths: readonly string[], trash: MoveToTrash, write: () => Promise<T>,
): Promise<{ readonly answer: T } | { readonly notTrashed: string }> {
  for (const path of paths) {
    const why = await whyNotTrashed(folder, path, trash);
    if (why !== undefined) return { notTrashed: why };
  }
  return { answer: await write() };
}

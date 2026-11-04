import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { errnoCode } from '../ports/errno';
import { sameStamp, settledBefore, stampOf, type FileStamp } from '../repositoriesLib/stampedReads';
import { GIT_DIR } from './files';

type MaybeStamped = FileStamp | undefined;

// A linked worktree and a submodule keep their index in the git directory their .git file names.
async function gitDirOf(repository: string): Promise<string> {
  const dotGit = join(repository, GIT_DIR);
  try {
    const linked = (await readFile(dotGit, 'utf8')).split('\n').find((line) => line.startsWith('gitdir:'));
    return linked === undefined ? dotGit : resolve(repository, linked.slice('gitdir:'.length).trim());
  } catch (err) {
    if (errnoCode(err) === 'EISDIR' || errnoCode(err) === 'ENOENT') return dotGit;
    throw err;
  }
}

const stampedIfThere = (path: string): Promise<MaybeStamped> =>
  stampOf(path).catch((err: unknown) => {
    if (errnoCode(err) === 'ENOENT' || errnoCode(err) === 'ENOTDIR') return undefined;
    throw err;
  });

const sameStamps = (a: readonly MaybeStamped[], b: readonly MaybeStamped[]): boolean =>
  a.length === b.length && a.every((stamp, i) => {
    const other = b[i];
    return stamp === undefined || other === undefined ? stamp === other : sameStamp(stamp, other);
  });

interface Kept<T> {
  readonly stamps: readonly MaybeStamped[];
  readonly value: T;
}

/** A keeper of what git answers from a repository's index and its .gitmodules alone: an answer is read once under its `key`
 *  and handed again while those two files keep their stamps. A failed read is never kept. */
export function keptByIndex<T>(): (repository: string, key: string, read: () => Promise<T>) => Promise<T> {
  const kept = new Map<string, Kept<T>>();
  return async (repository, key, read) => {
    const where = `${repository}\0${key}`;
    const stamps = await Promise.all([join(await gitDirOf(repository), 'index'), join(repository, '.gitmodules')].map(stampedIfThere));
    const held = kept.get(where);
    if (held !== undefined && sameStamps(held.stamps, stamps)) return held.value;
    const readFromMs = Date.now();
    const value = await read();
    if (stamps.every((stamp) => stamp === undefined || settledBefore(stamp, readFromMs))) kept.set(where, { stamps, value });
    else kept.delete(where);
    return value;
  };
}

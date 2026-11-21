import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { errnoCode, isAbsent } from '../ports/errno';
import { sameStamp, settledBefore, type FileStamp } from '../repositoriesLib/stampedReads';
import { GIT_DIR, readOrAbsent, stampByStamp, stampKept, stampOf } from './files';

type MaybeStamped = FileStamp | undefined;

// A linked worktree and a submodule keep their index in the git directory their .git file names.
const gitDirAt = stampKept(async (dotGit: string): Promise<string> => {
  try {
    const linked = (await readFile(dotGit, 'utf8')).split('\n').find((line) => line.startsWith('gitdir:'));
    return linked === undefined ? dotGit : resolve(dirname(dotGit), linked.slice('gitdir:'.length).trim());
  } catch (err) {
    if (errnoCode(err) === 'EISDIR') return dotGit;
    throw err;
  }
});

const gitDirOf = (repository: string): Promise<string> => readOrAbsent(() => gitDirAt(join(repository, GIT_DIR)), join(repository, GIT_DIR));

const stampedIfThere = (stamp: (path: string) => Promise<FileStamp>) => (path: string): Promise<MaybeStamped> =>
  stamp(path).catch((err: unknown) => {
    if (isAbsent(err)) return undefined;
    throw err;
  });

// The instance's watch follows its own .git folder's index and its .gitmodules; no watch follows a git directory elsewhere.
async function indexStamps(repository: string): Promise<MaybeStamped[]> {
  const dotGit = join(repository, GIT_DIR);
  const gitDir = await gitDirOf(repository);
  return Promise.all([
    stampedIfThere(gitDir === dotGit ? stampByStamp : stampOf)(join(gitDir, 'index')), stampedIfThere(stampByStamp)(join(repository, '.gitmodules')),
  ]);
}

const sameStamps = (a: readonly MaybeStamped[], b: readonly MaybeStamped[]): boolean =>
  a.length === b.length && a.every((stamp, i) => {
    const other = b[i];
    return stamp === undefined || other === undefined ? stamp === other : sameStamp(stamp, other);
  });

interface Kept<T> {
  readonly version: string;
  readonly stamps: readonly MaybeStamped[];
  readonly value: T;
}

/** What git answers from the index and .gitmodules, kept under its `key` while both keep their stamps and its `version`
 *  stays. A key keeps its latest version only. A failed read, or one `keeps` refuses, is not kept. */
export function keptByIndex<T>(keeps: (value: T) => boolean = () => true): (repository: string, key: string, read: () => Promise<T>, version?: string) => Promise<T> {
  const kept = new Map<string, Kept<T>>();
  return async (repository, key, read, version = '') => {
    const where = `${repository}\0${key}`;
    const stamps = await indexStamps(repository);
    const held = kept.get(where);
    if (held !== undefined && held.version === version && sameStamps(held.stamps, stamps)) return held.value;
    const readFromMs = Date.now();
    const value = await read();
    if (keeps(value) && stamps.every((stamp) => stamp === undefined || settledBefore(stamp, readFromMs))) kept.set(where, { version, stamps, value });
    else kept.delete(where);
    return value;
  };
}

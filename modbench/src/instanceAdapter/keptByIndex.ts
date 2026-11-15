import { join } from 'node:path';
import { sameStamp, settledBefore, type FileStamp } from '../repositoriesLib/stampedReads';
import { isAbsent, stampByStamp } from './files';
import { gitDirOf } from './git';

type MaybeStamped = FileStamp | undefined;

const stampedIfThere = (path: string): Promise<MaybeStamped> =>
  stampByStamp(path).catch((err: unknown) => {
    if (isAbsent(err)) return undefined;
    throw err;
  });

// The instance's watch follows its git directory's index and its .gitmodules.
async function indexStamps(repository: string): Promise<MaybeStamped[]> {
  return Promise.all([join(await gitDirOf(repository), 'index'), join(repository, '.gitmodules')].map(stampedIfThere));
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

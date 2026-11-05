/** What the file system says of a file without a read of its bytes. A tool can keep a file's size
 *  and date modified across a write, and ADR-0003 accepts that. */
export interface FileStamp {
  readonly size: bigint;
  readonly modifiedNs: bigint;
}

/** The stamp of a file from its `stat` with `bigint: true`. */
export const stampFrom = ({ size, mtimeNs }: { size: bigint; mtimeNs: bigint }): FileStamp =>
  ({ size, modifiedNs: mtimeNs });

export const sameStamp = (a: FileStamp, b: FileStamp): boolean =>
  a.size === b.size && a.modifiedNs === b.modifiedNs;

// A file system stamps a change with a clock coarser than a read is quick, and a network share's
// clock is not this machine's: a stamp this recent may not change for a write that follows it.
const SETTLED_AFTER_MS = 2_000;

export const settledBefore = (stamp: FileStamp, readFromMs: number): boolean =>
  stamp.modifiedNs < BigInt(readFromMs - SETTLED_AFTER_MS) * 1_000_000n;

export interface Kept<T> {
  readonly path: string;
  readonly stamp: FileStamp;
  readonly value: T;
  readonly settled: boolean;
}

interface KeptOptions<T> {
  readonly kept?: Map<string, Kept<T>>;
  readonly trusts?: () => boolean;
  readonly keyOf?: (path: string) => string;
}

/** A reader of `path` that reads it again only when its stamp has changed, or while its stamp is too fresh to trust. */
export function keptByStamp<T>(
  stampOf: (path: string) => Promise<FileStamp>, read: (path: string) => Promise<T>, { kept = new Map(), trusts = () => false, keyOf = (path) => path }: KeptOptions<T> = {},
): (path: string) => Promise<T> {
  return async (path) => {
    const key = keyOf(path);
    const held = kept.get(key);
    if (held?.settled === true && trusts()) return held.value;
    const stamp = await stampOf(path);
    if (held?.settled === true && sameStamp(held.stamp, stamp)) return held.value;
    const readFromMs = Date.now();
    const value = await read(path);
    kept.set(key, { path, stamp, value, settled: settledBefore(stamp, readFromMs) });
    return value;
  };
}

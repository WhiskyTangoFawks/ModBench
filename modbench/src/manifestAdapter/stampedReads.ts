import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';

// A file system stamps a change with a clock coarser than a read is quick, and a network share's clock is not this machine's.
const SETTLED_AFTER_MS = 2_000;

interface Stamp {
  readonly size: bigint;
  readonly modifiedNs: bigint;
  readonly changedNs: bigint;
}

async function stampOf(path: string): Promise<Stamp> {
  const info = await stat(path, { bigint: true });
  return { size: info.size, modifiedNs: info.mtimeNs, changedNs: info.ctimeNs };
}

const sameStamp = (a: Stamp, b: Stamp): boolean => a.size === b.size && a.modifiedNs === b.modifiedNs && a.changedNs === b.changedNs;

/** A reader of `path` that reads it again only when its stamp has changed, and never trusts a stamp younger than two seconds. */
export function keptByStamp<T>(read: (path: string) => Promise<T>): (path: string) => Promise<T> {
  const kept = new Map<string, { readonly stamp: Stamp; readonly value: T }>();
  return async (path) => {
    const stamp = await stampOf(path);
    const held = kept.get(path);
    if (held !== undefined && sameStamp(held.stamp, stamp)) return held.value;
    const readFromMs = Date.now();
    const value = await read(path);
    if (stamp.changedNs < BigInt(readFromMs - SETTLED_AFTER_MS) * 1_000_000n) kept.set(path, { stamp, value });
    else kept.delete(path);
    return value;
  };
}

/** The entries of a folder, listed again only when its stamp has changed. */
export const entriesByStamp: (folder: string) => Promise<Dirent[]> = keptByStamp((folder) => readdir(folder, { withFileTypes: true }));

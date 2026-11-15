import { AsyncLocalStorage } from 'node:async_hooks';
import { dirname, sep } from 'node:path';

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

// Windows names a file whatever the case of its path, and VS Code's watcher spells a drive in lower case.
const pathKey = (path: string): string => (process.platform === 'win32' ? path.toLowerCase() : path);

interface Keeper {
  readonly kept: Map<string, Kept<unknown>>;
  readonly stampOf: (path: string) => Promise<FileStamp>;
}

const everyKept: Keeper[] = [];
const trusting = new AsyncLocalStorage<true>();

/** A reader of `path` that reads it again only when its stamp has changed, read without its stamp while `readTrustingKept`
 *  or `trustingKept` runs, and checked by `readTrustingKept` where a change named it. */
export function keptTrusted<T>(stampOf: (path: string) => Promise<FileStamp>, read: (path: string) => Promise<T>, kept = new Map<string, Kept<T>>()): (path: string) => Promise<T> {
  everyKept.push({ kept, stampOf });
  return keptByStamp(stampOf, read, kept);
}

function touchedBy(named: readonly string[]): (key: string) => boolean {
  const keys = new Set(named.flatMap((path) => [pathKey(path), pathKey(dirname(path))]));
  const below = named.map((path) => pathKey(path) + sep);
  return (key) => keys.has(key) || below.some((folder) => key.startsWith(folder));
}

const stampStill = async (stampOf: Keeper['stampOf'], { path, stamp }: Kept<unknown>): Promise<boolean> => {
  try {
    return sameStamp(await stampOf(path), stamp);
  } catch {
    return false;
  }
};

async function forgetChanged(checked: (key: string) => boolean): Promise<string[]> {
  const picked = everyKept.flatMap(({ kept, stampOf }) => [...kept].filter(([key]) => checked(key)).map(([key, held]) => ({ kept, stampOf, key, held })));
  const changed = await Promise.all(picked.map(async ({ kept, stampOf, key, held }) => {
    if (await stampStill(stampOf, held)) return [];
    if (kept.get(key) === held) kept.delete(key);
    return [held.path];
  }));
  return [...new Set(changed.flat())];
}

/** Runs `read` trusting what is kept, once each kept path `named` touches, or every one when `disk`, is forgotten where its
 *  stamp changed. Answers each changed path `named` does not touch. A read outside it and `trustingKept` checks each stamp. */
export async function readTrustingKept<T>(named: readonly string[], disk: boolean, read: () => Promise<T>): Promise<{ answer: T; unheard: string[] }> {
  const touched = touchedBy(named);
  const changed = await forgetChanged(disk ? () => true : touched);
  return { answer: await trusting.run(true, read), unheard: changed.filter((path) => !touched(pathKey(path))) };
}

/** Runs `read` trusting what the latest `readTrustingKept` left kept. */
export const trustingKept = <T>(read: () => Promise<T>): Promise<T> => trusting.run(true, read);

/** Runs `arm` outside any read that trusts what is kept, so a timer, watch or listener it arms reads as any other caller. */
export const outsideTrustedRead = <T>(arm: () => T): T => trusting.exit(arm);

// A reader of `path` that reads it again only when its stamp has changed, or while its stamp is too fresh to trust.
function keptByStamp<T>(stampOf: (path: string) => Promise<FileStamp>, read: (path: string) => Promise<T>, kept: Map<string, Kept<T>>): (path: string) => Promise<T> {
  return async (path) => {
    const key = pathKey(path);
    const held = kept.get(key);
    if (held?.settled === true && trusting.getStore() === true) return held.value;
    const stamp = await stampOf(path);
    if (held?.settled === true && sameStamp(held.stamp, stamp)) return held.value;
    const readFromMs = Date.now();
    const value = await read(path);
    kept.set(key, { path, stamp, value, settled: settledBefore(stamp, readFromMs) });
    return value;
  };
}

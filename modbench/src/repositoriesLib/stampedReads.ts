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
export const pathKey = (path: string): string => (process.platform === 'win32' ? path.toLowerCase() : path);

interface Change {
  readonly disk: boolean;
  readonly named: readonly string[];
  /** Whether a path named is the key, in its folder, or holds it. */
  readonly touched: (key: string) => boolean;
}

// Forgets each kept answer `change` may have changed, and answers the paths that did.
type Keeper = (change: Change) => Promise<string[]>;

const everyKept: Keeper[] = [];
const trusting = new AsyncLocalStorage<true>();

/** A reader of `path` that reads it again only when its stamp has changed, read without its stamp while `readTrustingKept`
 *  or `trustingKept` runs, and checked by `readTrustingKept` where a change named it. */
export function keptTrusted<T>(
  stampOf: (path: string) => Promise<FileStamp>, read: (path: string) => Promise<T>, kept = new Map<string, Kept<T>>(), stampMayMiss = false,
): (path: string) => Promise<T> {
  // A folder's stamp can stay as it was for an entry added (ADR-0003), so a change named and a check of the disk forget it.
  everyKept.push(({ disk, touched }) => forgetChanged(kept, stampOf, disk ? () => true : touched, stampMayMiss));
  return keptByStamp(stampOf, read, kept);
}

/** A reader of what no stamp of `path` covers, read once inside `readTrustingKept` or `trustingKept` until a change names
 *  `path`, `changedBy` its value and the paths named, or the disk is checked, and each time outside them. */
export function keptUntilNamed<T>(
  read: (path: string) => Promise<T>, changedBy: (value: T, named: readonly string[]) => boolean = () => false,
): (path: string) => Promise<T> {
  const kept = new Map<string, { readonly value: T }>();
  everyKept.push(({ disk, named, touched }) => {
    for (const [key, { value }] of [...kept]) if (disk || touched(key) || changedBy(value, named)) kept.delete(key);
    return Promise.resolve([]);
  });
  return async (path) => {
    const key = pathKey(path);
    if (trusting.getStore() !== true) return read(path);
    const held = kept.get(key);
    if (held !== undefined) return held.value;
    const value = await read(path);
    kept.set(key, { value });
    return value;
  };
}

function touchedBy(named: readonly string[]): (key: string) => boolean {
  const keys = new Set(named.flatMap((path) => [pathKey(path), pathKey(dirname(path))]));
  const below = named.map((path) => pathKey(path) + sep);
  return (key) => keys.has(key) || below.some((folder) => key.startsWith(folder));
}

const stampStill = async (stampOf: (path: string) => Promise<FileStamp>, { path, stamp }: Kept<unknown>): Promise<boolean> => {
  try {
    return sameStamp(await stampOf(path), stamp);
  } catch {
    return false;
  }
};

async function forgetChanged<T>(
  kept: Map<string, Kept<T>>, stampOf: (path: string) => Promise<FileStamp>, checked: (key: string) => boolean, outright: boolean,
): Promise<string[]> {
  const changed = await Promise.all([...kept].filter(([key]) => checked(key)).map(async ([key, held]) => {
    const still = await stampStill(stampOf, held);
    if ((outright || !still) && kept.get(key) === held) kept.delete(key);
    return still ? [] : [held.path];
  }));
  return changed.flat();
}

/** Runs `read` trusting what is kept, once what each kept path `named` touches, or every one when `disk`, is forgotten where
 *  it may have changed. Answers each changed stamp `named` does not touch. A read outside it checks each stamp. */
export async function readTrustingKept<T>(named: readonly string[], disk: boolean, read: () => Promise<T>): Promise<{ answer: T; unheard: string[] }> {
  const touched = touchedBy(named);
  const changed = (await Promise.all(everyKept.map((forget) => forget({ disk, named, touched })))).flat();
  return { answer: await trusting.run(true, read), unheard: [...new Set(changed)].filter((path) => !touched(pathKey(path))) };
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

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
  /** The content a write handed over, for the one read that names it. */
  readonly handed?: boolean;
}

// Windows names a file whatever the case of its path, and VS Code's watcher spells a drive in lower case.
export const pathKey = (path: string): string => (process.platform === 'win32' ? path.toLowerCase() : path);

// Forgets each kept answer whose key `checked` picks and that may have changed, and answers the paths that did.
type Keeper = (checked: (key: string) => boolean, unchanged: Set<string>) => Promise<string[]>;

const everyKept: Keeper[] = [];
const trusting = new AsyncLocalStorage<{ readonly unchanged: Set<string> }>();

/** Notes that a read inside `readTrustingKept` compared the content of the file at `path` and found it as it was held. */
export const foundUnchanged = (path: string): void => {
  trusting.getStore()?.unchanged.add(pathKey(path));
};

/** A reader of `path` that reads it again only when its stamp has changed, and trusts what is kept inside a trusted read.
 *  `comparesText`: the answer is a file's content, which a settled stamp that holds shows unchanged, and which a changed one
 *  leaves kept for the read again to compare with (ADR-0029). */
export function keptTrusted<T>(
  stampOf: (path: string) => Promise<FileStamp>, read: (path: string) => Promise<T>, kept = new Map<string, Kept<T>>(), stampMayMiss = false, comparesText = false,
): (path: string) => Promise<T> {
  // A folder's stamp can stay as it was for an entry added (ADR-0003), so a change named and a check of the disk forget it.
  everyKept.push((checked, unchanged) => forgetChanged(kept, stampOf, checked, stampMayMiss, comparesText ? unchanged : undefined));
  return keptByStamp(stampOf, read, kept);
}

/** Keeps `value`, the content a write of `path` just made, as the answer of the one trusted read that names it. A read after that
 *  checks the stamp as any other. */
export function handKept<T>(kept: Map<string, Kept<T>>, path: string, value: T, stamp: FileStamp): void {
  kept.set(pathKey(path), { path, stamp, value, settled: false, handed: true });
}

const alsoKeyOf = (path: string | undefined): string | undefined => (path === undefined ? undefined : pathKey(path));

/** A reader of what no stamp of `path` covers, read once inside `readTrustingKept` or `trustingKept` until a change names
 *  `path`, or the path `alsoNamedBy` gives for the answer, or the disk is checked, and each time outside them. */
export function keptUntilNamed<T, Given = void>(
  read: (path: string, given: Given) => Promise<T>, alsoNamedBy?: (value: T) => string | undefined,
): (path: string, given: Given) => Promise<T> {
  const kept = new Map<string, { readonly value: T; readonly also: string | undefined }>();
  everyKept.push((checked) => {
    for (const [key, { also }] of [...kept]) if (checked(key) || (also !== undefined && checked(also))) kept.delete(key);
    return Promise.resolve([]);
  });
  return async (path, given) => {
    const key = pathKey(path);
    if (trusting.getStore() === undefined) return read(path, given);
    const held = kept.get(key);
    if (held !== undefined) return held.value;
    const value = await read(path, given);
    kept.set(key, { value, also: alsoKeyOf(alsoNamedBy?.(value)) });
    return value;
  };
}

function touchedBy(named: readonly string[]): (key: string) => boolean {
  const keys = new Set(named.flatMap((path) => [pathKey(path), pathKey(dirname(path))]));
  const below = named.map((path) => pathKey(path) + sep);
  return (key) => keys.has(key) || below.some((folder) => key.startsWith(folder));
}

const stampNow = async (stampOf: (path: string) => Promise<FileStamp>, path: string): Promise<FileStamp | undefined> => {
  try {
    return await stampOf(path);
  } catch {
    return undefined;
  }
};

// A text a read found stays kept through a changed stamp, for the read again to compare with (ADR-0029).
function keptThrough<T>(held: Kept<T>, now: FileStamp | undefined, outright: boolean, comparable: boolean): Kept<T> | undefined {
  if (outright || now === undefined) return undefined;
  if (sameStamp(now, held.stamp)) return held;
  return comparable ? { ...held, stamp: now, settled: false } : undefined;
}

async function forgetChanged<T>(
  kept: Map<string, Kept<T>>, stampOf: (path: string) => Promise<FileStamp>, checked: (key: string) => boolean, outright: boolean,
  unchanged?: Set<string>,
): Promise<string[]> {
  const changed = await Promise.all([...kept].filter(([key]) => checked(key)).map(async ([key, held]) => {
    const now = await stampNow(stampOf, held.path);
    const still = now !== undefined && sameStamp(now, held.stamp);
    const comparable = unchanged !== undefined && held.handed !== true;
    if (comparable && still && held.settled) unchanged.add(pathKey(held.path));
    const left = keptThrough(held, now, outright, comparable);
    if (kept.get(key) === held && left !== held) {
      if (left === undefined) kept.delete(key);
      else kept.set(key, left);
    }
    return still ? [] : [held.path];
  }));
  return changed.flat();
}

/** Runs `read` trusting what is kept, once what each kept path `named` touches, or every one when `disk`, is forgotten where
 *  it may have changed. Answers each changed stamp `named` does not touch. A read outside it checks each stamp. */
export async function readTrustingKept<T>(
  named: readonly string[], disk: boolean, read: () => Promise<T>,
): Promise<{ answer: T; unheard: string[]; unchanged: ReadonlySet<string> }> {
  const unchanged = new Set<string>();
  const touched = touchedBy(named);
  const changed = (await Promise.all(everyKept.map((forget) => forget(disk ? () => true : touched, unchanged)))).flat();
  return { answer: await trusting.run({ unchanged }, read), unheard: [...new Set(changed)].filter((path) => !touched(pathKey(path))), unchanged };
}

/** Runs `read` trusting what the latest `readTrustingKept` left kept. */
export const trustingKept = <T>(read: () => Promise<T>): Promise<T> => trusting.run({ unchanged: new Set() }, read);

/** Runs `arm` outside any read that trusts what is kept, so a timer, watch or listener it arms reads as any other caller. */
export const outsideTrustedRead = <T>(arm: () => T): T => trusting.exit(arm);

// A reader of `path` that reads it again only when its stamp has changed, or while its stamp is too fresh to trust.
function keptByStamp<T>(stampOf: (path: string) => Promise<FileStamp>, read: (path: string) => Promise<T>, kept: Map<string, Kept<T>>): (path: string) => Promise<T> {
  return async (path) => {
    const key = pathKey(path);
    const held = kept.get(key);
    if (held?.settled === true && trusting.getStore() !== undefined) return held.value;
    // What a failed read kept is no longer what was found last.
    const forget = (error: unknown): never => {
      kept.delete(key);
      throw error;
    };
    const stamp = await stampOf(path).catch(forget);
    if (held?.handed === true && trusting.getStore() !== undefined && sameStamp(held.stamp, stamp)) {
      kept.set(key, { ...held, handed: false });
      return held.value;
    }
    if (held?.settled === true && sameStamp(held.stamp, stamp)) return held.value;
    const readFromMs = Date.now();
    const value = await read(path).catch(forget);
    kept.set(key, { path, stamp, value, settled: settledBefore(stamp, readFromMs) });
    return value;
  };
}

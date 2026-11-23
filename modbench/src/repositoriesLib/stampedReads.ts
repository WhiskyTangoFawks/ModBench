import { AsyncLocalStorage } from 'node:async_hooks';
import { dirname, sep } from 'node:path';
import { isAbsent } from '../ports/errno';

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

interface Answered<T> {
  readonly path: string;
  readonly stamp: FileStamp;
  readonly value: T;
  readonly settled: boolean;
  /** The content a write handed over, for the one read that names it. */
  readonly handed?: boolean;
}

// A path found not there, with the failure that said so.
interface Absent {
  readonly path: string;
  readonly absent: Error;
}

export type Kept<T> = Answered<T> | Absent;

const answeredOf = <T>(held: Kept<T> | undefined): Answered<T> | undefined => (held === undefined || 'absent' in held ? undefined : held);

// Windows names a file whatever the case of its path, and VS Code's watcher spells a drive in lower case.
export const pathKey = (path: string): string => (process.platform === 'win32' ? path.toLowerCase() : path);

// Forgets each kept answer whose key `checked` picks and that may have changed, and answers the paths that did.
type Keeper = (checked: (key: string) => boolean) => Promise<string[]>;

const everyKept: Keeper[] = [];
// What a trusted read found of each file whose content it compares.
const trusting = new AsyncLocalStorage<{ readonly found: Map<string, unknown> }>();

/** A reader of `path`, read again once its stamp changed. Inside a trusted read what it kept, settled or absent, stands until
 *  a change names the path or the disk is checked. `comparesText`: it answers content, noted as found. */
export function keptTrusted<T>(
  stampOf: (path: string) => Promise<FileStamp>, read: (path: string) => Promise<T>, kept = new Map<string, Kept<T>>(), stampMayMiss = false, comparesText = false,
): (path: string) => Promise<T> {
  // A folder's stamp can stay as it was for an entry added (ADR-0003), so a change named and a check of the disk forget it.
  everyKept.push((checked) => forgetChanged(kept, stampOf, checked, stampMayMiss));
  const reader = keptByStamp(stampOf, read, kept);
  return comparesText ? async (path) => {
    const value = await reader(path);
    trusting.getStore()?.found.set(pathKey(path), value);
    return value;
  } : reader;
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

// A kept key the paths named touch: one of them, the folder of one, or beneath one, found by the folders above the key.
function touchedBy(named: readonly string[]): (key: string) => boolean {
  const keys = new Set(named.flatMap((path) => [pathKey(path), pathKey(dirname(path))]));
  const folders = new Set(named.map(pathKey));
  return (key) => {
    if (keys.has(key)) return true;
    // A key that ends in a separator stands for what is below its folder.
    for (let above = key.endsWith(sep) ? key.slice(0, -1) : dirname(key); above !== dirname(above); above = dirname(above)) if (folders.has(above)) return true;
    return false;
  };
}

const stampStill = async (stampOf: (path: string) => Promise<FileStamp>, held: Kept<unknown>): Promise<boolean> => {
  const answered = answeredOf(held);
  try {
    const stamp = await stampOf(held.path);
    return answered !== undefined && sameStamp(stamp, answered.stamp);
  } catch (err) {
    return answered === undefined && isAbsent(err);
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

/** Forgets each kept answer that `named` touches, or any when `disk`, that may have changed, then runs `read` trusting the
 *  rest. Answers its answer, each changed path `named` missed, the contents it found, and those `before` holds the same. */
export async function readTrustingKept<T>(
  named: readonly string[], disk: boolean, read: () => Promise<T>, before?: ReadonlyMap<string, unknown>,
): Promise<{ answer: T; unheard: string[]; found: ReadonlyMap<string, unknown>; unchanged: ReadonlySet<string> }> {
  const touched = touchedBy(named);
  const changed = (await Promise.all(everyKept.map((forget) => forget(disk ? () => true : touched)))).flat();
  const found = new Map<string, unknown>();
  const answer = await trusting.run({ found }, read);
  const unchanged = new Set([...found].filter(([key, value]) => before?.has(key) === true && Object.is(before.get(key), value)).map(([key]) => key));
  return { answer, unheard: [...new Set(changed)].filter((path) => !touched(pathKey(path))), found: new Map(found), unchanged };
}

/** Runs `read` trusting what the latest `readTrustingKept` left kept. */
export const trustingKept = <T>(read: () => Promise<T>): Promise<T> => trusting.run({ found: new Map() }, read);

/** Runs `arm` outside any read that trusts what is kept, so a timer, watch or listener it arms reads as any other caller. */
export const outsideTrustedRead = <T>(arm: () => T): T => trusting.exit(arm);

// What a trusted read answers from what is kept, with no look at the stamp; undefined where it must look.
function keptAnswer<T>(held: Kept<T> | undefined): Promise<T> | undefined {
  if (held !== undefined && 'absent' in held) return Promise.reject(held.absent);
  return held?.settled === true ? Promise.resolve(held.value) : undefined;
}

async function stampKeepingAbsence<T>(stampOf: (path: string) => Promise<FileStamp>, kept: Map<string, Kept<T>>, key: string, path: string): Promise<FileStamp> {
  try {
    return await stampOf(path);
  } catch (err) {
    if (isAbsent(err) && err instanceof Error) kept.set(key, { path, absent: err });
    throw err;
  }
}

// A reader of `path` that reads it again only when its stamp has changed, or while its stamp is too fresh to trust.
function keptByStamp<T>(stampOf: (path: string) => Promise<FileStamp>, read: (path: string) => Promise<T>, kept: Map<string, Kept<T>>): (path: string) => Promise<T> {
  return async (path) => {
    const key = pathKey(path);
    const trusts = trusting.getStore() !== undefined;
    const was = kept.get(key);
    const answer = trusts ? keptAnswer(was) : undefined;
    if (answer !== undefined) return answer;
    const held = answeredOf(was);
    const stamp = await stampKeepingAbsence(stampOf, kept, key, path);
    if (trusts && held?.handed === true && sameStamp(held.stamp, stamp)) {
      kept.set(key, { ...held, handed: false });
      return held.value;
    }
    if (held?.settled === true && sameStamp(held.stamp, stamp)) return held.value;
    const readFromMs = Date.now();
    const value = await read(path);
    kept.set(key, { path, stamp, value, settled: settledBefore(stamp, readFromMs) });
    return value;
  };
}

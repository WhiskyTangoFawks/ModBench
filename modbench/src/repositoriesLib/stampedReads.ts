import { AsyncLocalStorage } from 'node:async_hooks';
import { dirname, sep } from 'node:path';
import { errnoCode } from '../ports/errno';

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

/** A path found not there, with the failure that said so. */
interface Absent {
  readonly path: string;
  readonly absent: unknown;
}

export type Kept<T> = Answered<T> | Absent;

// The path, or a folder along it, is missing or is a file.
const isAbsence = (err: unknown): boolean => errnoCode(err) === 'ENOENT' || errnoCode(err) === 'ENOTDIR';

// Windows names a file whatever the case of its path, and VS Code's watcher spells a drive in lower case.
export const pathKey = (path: string): string => (process.platform === 'win32' ? path.toLowerCase() : path);

// Forgets each kept answer whose key `checked` picks and that may have changed, and answers the paths that did.
type Keeper = (checked: (key: string) => boolean) => Promise<string[]>;

const everyKept: Keeper[] = [];
// What a trusted read found of each file whose content it compares.
const trusting = new AsyncLocalStorage<{ readonly found: Map<string, unknown> }>();

/** A reader of `path` that reads it again only when its stamp has changed, and trusts what is kept inside a trusted read, a
 *  path found not there too. `comparesText`: the answer is a file's content, which `readTrustingKept` notes as found. */
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

function touchedBy(named: readonly string[]): (key: string) => boolean {
  const keys = new Set(named.flatMap((path) => [pathKey(path), pathKey(dirname(path))]));
  const below = named.map((path) => pathKey(path) + sep);
  return (key) => keys.has(key) || below.some((folder) => key.startsWith(folder));
}

const stampStill = async (stampOf: (path: string) => Promise<FileStamp>, held: Kept<unknown>): Promise<boolean> => {
  try {
    const stamp = await stampOf(held.path);
    return !('absent' in held) && sameStamp(stamp, held.stamp);
  } catch (err) {
    return 'absent' in held && isAbsence(err);
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
 *  it may have changed. Answers each changed stamp `named` does not touch, the content it `found` of each file whose content
 *  it compares, and each such file it found as `before`, what another run found, holds it (ADR-0029). A read outside it
 *  checks each stamp. */
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

const answeredOf = <T>(held: Kept<T> | undefined): Answered<T> | undefined => (held === undefined || 'absent' in held ? undefined : held);

// What a trusted read hands of what is kept without a look at the stamp: a settled answer, or the absence found.
function trustedAsKept<T>(held: Kept<T> | undefined): Answered<T> | undefined {
  if (held !== undefined && 'absent' in held) throw held.absent;
  const answered = answeredOf(held);
  return answered?.settled === true ? answered : undefined;
}

// `path`'s stamp; a path found not there is kept as not there.
async function stampKeepingAbsence<T>(stampOf: (path: string) => Promise<FileStamp>, kept: Map<string, Kept<T>>, key: string, path: string): Promise<FileStamp> {
  try {
    return await stampOf(path);
  } catch (err) {
    if (isAbsence(err)) kept.set(key, { path, absent: err });
    throw err;
  }
}

// A reader of `path` that reads it again only when its stamp has changed, or while its stamp is too fresh to trust.
function keptByStamp<T>(stampOf: (path: string) => Promise<FileStamp>, read: (path: string) => Promise<T>, kept: Map<string, Kept<T>>): (path: string) => Promise<T> {
  return async (path) => {
    const key = pathKey(path);
    const trusts = trusting.getStore() !== undefined;
    const was = kept.get(key);
    const trusted = trusts ? trustedAsKept(was) : undefined;
    if (trusted !== undefined) return trusted.value;
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

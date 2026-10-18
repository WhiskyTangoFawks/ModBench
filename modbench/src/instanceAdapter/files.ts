// The Instance adapter: the one reader and writer of the instance (target-architecture.d2's
// `instanceadapter` box). The adapter splices a command's change through the file's codec and
// writes the file whole.

import { constants, type Dirent } from 'node:fs';
import {
  access, appendFile, chmod, cp, mkdir, mkdtemp, readFile, readdir, realpath, rename as fsRename, rm, stat, writeFile,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  isTempWriteOf, repositoryGitDir, tempWritePath,
} from './layout';
import { errnoCode } from './errno';
import { errorMessage } from '../ports/errorMessage';
import type { FileRead, FileStamp } from './instanceAdapter';

/** ADR-0007, answered without the backend. */
export function isRepository(sourceFolder: string): Promise<boolean> {
  return exists(repositoryGitDir(sourceFolder));
}

// One chain per path in flight: a file with no writer pending costs nothing, and two different
// paths never serialize against each other. Module-level, so every command shares one adapter.
const chains = new Map<string, Promise<unknown>>();

/** Runs `task` after every task already queued on `key`, holding the lock every write of that path
 *  here takes until `task` settles, and answers what it answered. */
export function withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prior = chains.get(key) ?? Promise.resolve();
  const next = prior.then(task, task);
  // The chain tail must never stay rejected, or a later write on this key queues behind a dead
  // link forever — only the caller's own `next` sees the error.
  const settled = next.then(() => undefined, () => undefined);
  chains.set(key, settled);
  // An idle key is forgotten, so a long session holds only what is in flight.
  void settled.then(() => {
    if (chains.get(key) === settled) chains.delete(key);
  });
  return next;
}

async function readOr(path: string, ifMissing: string | undefined): Promise<string> {
  if (ifMissing === undefined) return readFile(path, 'utf8');
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if (errnoCode(err) !== 'ENOENT') throw err;
    return ifMissing;
  }
}

interface PutOptions {
  /** A missing file reads as this text rather than rejecting. Omit to have a missing file
   *  refuse the write. */
  ifMissing?: string;
}

/** Whether `path`, file or directory, is there. Only a missing path answers false; any other
 *  failure (a permission error, say) propagates rather than reading as absent (ADR-0019). */
export async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return false;
    throw err;
  }
}

interface PathFacts {
  readonly size: number;
  readonly mtimeMs: number;
  /** `other` covers a non-regular target (a socket, FIFO or device node) — a caller's own
   *  skip-and-log, never a fourth branch here. */
  readonly kind: 'file' | 'directory' | 'other';
  /** `path` with every symlink along it resolved; itself when `path` names no symlink. */
  readonly realPath: string;
}

/** `path`'s size, modified time and kind, following symlinks the way a directory walk does —
 *  `stat`, not `lstat`. Sequential, so a `stat` failure propagates before `realpath` runs. */
export async function factsOf(path: string): Promise<PathFacts> {
  const info = await stat(path);
  const kind: PathFacts['kind'] = info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other';
  const realPath = await realpath(path);
  return { size: info.size, mtimeMs: info.mtimeMs, kind, realPath };
}

/** `path`'s stamp, following symlinks. */
export async function stampOf(path: string): Promise<FileStamp> {
  const info = await stat(path, { bigint: true });
  return { size: info.size, modifiedNs: info.mtimeNs, changedNs: info.ctimeNs };
}

/** Reads `path` as text. Pass `ifMissing` to read a missing file as that text instead of
 *  rejecting. */
export function get(path: string, ifMissing?: string): Promise<string> {
  return readOr(path, ifMissing);
}

/** `path` with every symlink along it resolved, or `undefined` when nothing is there. */
export async function realPathIfThere(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch (err) {
    if (errnoCode(err) !== 'ENOENT') throw err;
    return undefined;
  }
}

// `path` itself when it names no symlink, or a missing path; its resolved real file otherwise —
// a write must land on what a symlink points at, not replace the link with a plain file.
async function writeTargetOf(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (err) {
    if (errnoCode(err) !== 'ENOENT') throw err;
    return path;
  }
}

// `target`'s mode, or undefined when there is no file there yet.
async function modeOf(target: string): Promise<number | undefined> {
  try {
    return (await stat(target)).mode;
  } catch (err) {
    if (errnoCode(err) !== 'ENOENT') throw err;
    return undefined;
  }
}

/** Removes the temp writes a crash left behind for `target`, between a temp landing and its
 *  rename; a write for `target` sweeps them before starting its own. */
export async function removeStaleTempsFor(target: string): Promise<void> {
  const dir = dirname(target);
  const base = basename(target);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if (errnoCode(err) !== 'ENOENT') throw err;
    return;
  }
  await Promise.all(
    names.filter((name) => isTempWriteOf(base, name))
      .map((name) => rm(join(dir, name), { force: true })),
  );
}

// `err`'s message, with the temp path swapped for `target` — the path the caller asked for and
// the only one it ever saw.
function reportedAsTarget(err: unknown, tmp: string, target: string): unknown {
  if (!(err instanceof Error) || !err.message.includes(tmp)) return err;
  return Object.assign(new Error(err.message.split(tmp).join(target)), { code: errnoCode(err) });
}

// A temp file beside the real target, then one rename: never a partial read, never a target
// left half-written. Not writable is refused before any temp is written.
async function writeAtomic(path: string, text: string): Promise<void> {
  const target = await writeTargetOf(path);
  await removeStaleTempsFor(target);
  const mode = await modeOf(target);
  if (mode !== undefined) await access(target, constants.W_OK);
  const tmp = tempWritePath(target);
  try {
    await writeFile(tmp, text);
    if (mode !== undefined) await chmod(tmp, mode);
    await fsRename(tmp, target);
  } catch (err) {
    await rm(tmp, { force: true });
    throw reportedAsTarget(err, tmp, target);
  }
}

/** Writes `text` to `path` outright — no read-back, no splice, no lock: install's own meta.ini. */
export function write(path: string, text: string): Promise<void> {
  return writeAtomic(path, text);
}

export function append(path: string, text: string): Promise<void> {
  return appendFile(path, text);
}

/** Moves `from` to `to` in one filesystem step — an install's own entries moving up into a mod folder. */
export function rename(from: string, to: string): Promise<void> {
  return fsRename(from, to);
}

/** Copies `from`'s whole tree to `to`, leaving `from` in place. */
export function copyTree(from: string, to: string): Promise<void> {
  return cp(from, to, { recursive: true });
}

/** A fresh, uniquely-named directory made from `prefix`. */
export function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(prefix);
}

/** Creates `path` alone, its parent already there. Rejects with EEXIST when another tool got
 *  there first, so the caller owns exactly what it made. */
export function makeDir(path: string): Promise<void> {
  return mkdir(path).then(() => undefined);
}

/** `path`'s directory entries; the caller's own filter picks the ones it wants. */
export function listDir(path: string): Promise<Dirent[]> {
  return readdir(path, { withFileTypes: true });
}

/** Hands over a link that cannot be followed, by its path, with why. */
export type SkippedLink = (linkPath: string, reason: string) => void;

/** For a caller to whom a link it cannot follow is the same as no entry. */
export const ignoreSkippedLink: SkippedLink = () => undefined;

/** A directory entry as what it is, a link being what it links to. */
export interface ResolvedEntry {
  readonly name: string;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
}

/** The entries directly in `path`, following links as MO2 does (QDir without NoSymLinks).
 *  A link whose target cannot be checked is skipped, as MO2 skips it, and handed to `skippedLink`. */
export async function listEntries(
  path: string, skippedLink: SkippedLink,
): Promise<ResolvedEntry[]> {
  const entries = await Promise.all((await listDir(path)).map(async (dirent): Promise<ResolvedEntry | undefined> => {
    const { name } = dirent;
    if (!dirent.isSymbolicLink()) return { name, isFile: dirent.isFile(), isDirectory: dirent.isDirectory() };
    try {
      const target = await stat(join(path, name));
      return { name, isFile: target.isFile(), isDirectory: target.isDirectory() };
    } catch (err) {
      skippedLink(join(path, name), errorMessage(err));
      return undefined;
    }
  }));
  return entries.filter((entry): entry is ResolvedEntry => entry !== undefined);
}

/** The folders directly in `path`, links followed as `listEntries` follows them. */
export async function listFolders(
  path: string, skippedLink: SkippedLink,
): Promise<string[]> {
  return (await listEntries(path, skippedLink)).filter((entry) => entry.isDirectory).map((entry) => entry.name);
}

/** Creates `path` and every missing parent; a no-op when it is already there. */
export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

/** Deletes `path`, file or directory, and everything under it; already-gone is not an error. */
export function remove(path: string): Promise<void> {
  return rm(path, { recursive: true, force: true });
}

/** Hands `edit` the text of `path`, serialized per path, and skips the write when `edit` changed
 *  nothing, so an unwritten file never fires its watcher. An awaiting `edit` holds the lock. */
export function putIfChanged(
  path: string, edit: (before: string) => string | Promise<string>, opts: PutOptions = {},
): Promise<{ wrote: boolean }> {
  return withLock(path, async () => {
    const before = await readOr(path, opts.ifMissing);
    const after = await edit(before);
    if (after === before) return { wrote: false };
    await writeAtomic(path, after);
    return { wrote: true };
  });
}

export type Undo = () => Promise<void>;

// Every undo is tried in the order given, and each one that fails is named beside the failure it
// followed.
export async function undoAll(undos: readonly Undo[], err: unknown): Promise<unknown> {
  const failures: string[] = [];
  for (const undo of undos) {
    try {
      await undo();
    } catch (undoErr) {
      failures.push(errorMessage(undoErr));
    }
  }
  if (failures.length === 0) return err;
  return new Error(`${errorMessage(err)}; not put back: ${failures.join('; ')}`);
}

/** What `read` answers, or why it could not, rather than failing whatever asked. */
export async function readOrReason<T>(read: () => Promise<T>): Promise<FileRead<T>> {
  try {
    return { kind: 'read', answer: await read() };
  } catch (err) {
    return { kind: 'unreadable', reason: errorMessage(err) };
  }
}

/** A missing file answers `absent`; any other failure rejects. */
export async function readOrAbsent<T>(read: () => Promise<T>, absent: T): Promise<T> {
  try {
    return await read();
  } catch (err) {
    if (errnoCode(err) !== 'ENOENT') throw err;
    return absent;
  }
}

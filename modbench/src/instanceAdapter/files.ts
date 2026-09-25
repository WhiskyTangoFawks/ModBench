// The Instance adapter: the one reader and writer of the instance (target-architecture.d2's
// `instanceadapter` box). A command splices a file's text through its own codec and puts the
// result through here.

import { existsSync, type Dirent } from 'node:fs';
import {
  access, cp, mkdir, mkdtemp, readFile, readdir, realpath, rename as fsRename, rm, stat, writeFile,
} from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { modsDir as modsDirOf, modGitDir, profilesDir, settingsFile } from './layout';
import { errnoCode } from '../ports/errno';
import { errorMessage } from '../ports/errorMessage';

/** Structural presence only, never file contents: an instance with a corrupt `modlist.txt` still
 *  reads `true` here, and surfaces that error elsewhere (ADR-0019). Synchronous: the composition
 *  root asks before an Instance exists. */
export function isMo2Instance(root: string): boolean {
  return existsSync(settingsFile(root)) && existsSync(modsDirOf(root)) && existsSync(profilesDir(root));
}

/** ADR-0007: tracked *is* the presence of `.git` in the mod's folder — no registry, no backend. */
export function isTracked(modFolder: string): Promise<boolean> {
  return exists(modGitDir(modFolder));
}

// One chain per path in flight: a file with no writer pending costs nothing, and two different
// paths never serialize against each other. Module-level, so every command shares one adapter.
const chains = new Map<string, Promise<unknown>>();

// Runs `task` after every task already queued on `key`, and answers what it answered.
function withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
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

export interface PutOptions {
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

export interface PathFacts {
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

/** Reads `path` as text. Pass `ifMissing` to read a missing file as that text instead of
 *  rejecting. */
export function get(path: string, ifMissing?: string): Promise<string> {
  return readOr(path, ifMissing);
}

/** Writes `text` to `path` outright — no read-back, no splice, no lock: a landing mod's own
 *  meta.ini, written once into a staged tree nothing else can see yet. */
export function write(path: string, text: string): Promise<void> {
  return writeFile(path, text);
}

/** Moves `from` to `to` in one filesystem step — a staged tree landing in `mods/`, or an
 *  install's own entries moving into an existing mod folder. */
export function rename(from: string, to: string): Promise<void> {
  return fsRename(from, to);
}

/** Copies `from`'s whole tree to `to`, leaving `from` in place — a source folder staged before
 *  its one rename into `mods/`. */
export function copyTree(from: string, to: string): Promise<void> {
  return cp(from, to, { recursive: true });
}

/** A fresh, uniquely-named directory next to `prefix`, for a staged tree no watcher's glob
 *  reaches until its one rename into place. */
export function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(prefix);
}

/** `path`'s directory entries; the caller's own filter picks the ones it wants. */
export function listDir(path: string): Promise<Dirent[]> {
  return readdir(path, { withFileTypes: true });
}

/** The folders directly in `path`, following links as MO2 does (QDir::Dirs without NoSymLinks).
 *  A link whose target cannot be checked is skipped, as MO2 skips it, and handed to `skippedLink`. */
export async function listFolders(
  path: string, skippedLink?: (name: string, reason: string) => void,
): Promise<string[]> {
  const folders = await Promise.all((await listDir(path)).map(async (dirent) => {
    if (dirent.isDirectory()) return dirent.name;
    if (!dirent.isSymbolicLink()) return undefined;
    try {
      return (await stat(join(path, dirent.name))).isDirectory() ? dirent.name : undefined;
    } catch (err) {
      skippedLink?.(dirent.name, errorMessage(err));
      return undefined;
    }
  }));
  return folders.filter((name): name is string => name !== undefined);
}

/** Creates `path` and every missing parent; a no-op when it is already there. */
export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

/** Deletes `path`, file or directory, and everything under it; already-gone is not an error. */
export function remove(path: string): Promise<void> {
  return rm(path, { recursive: true, force: true });
}

/** Reads `path`, hands the text to `edit`, and always writes the result back once — the download
 *  sidecar's own contract (ADR-0014 invariant 4). Serialized per path. */
export async function put(path: string, edit: (before: string) => string, opts: PutOptions = {}): Promise<void> {
  await withLock(path, async () => {
    const before = await readOr(path, opts.ifMissing);
    await writeFile(path, edit(before));
  });
}

/** Like {@link put}, but skips the write when `edit` changed nothing, so an unwritten file never
 *  fires its watcher. Answers whether it wrote. An `edit` that awaits holds the lock meanwhile. */
export function putIfChanged(
  path: string, edit: (before: string) => string | Promise<string>, opts: PutOptions = {},
): Promise<{ wrote: boolean }> {
  return withLock(path, async () => {
    const before = await readOr(path, opts.ifMissing);
    const after = await edit(before);
    if (after === before) return { wrote: false };
    await writeFile(path, after);
    return { wrote: true };
  });
}

/** Every file under `root`, as forward-slash relative paths. */
export async function listRelativeFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const dirent of await listDir(dir)) {
      const abs = join(dir, dirent.name);
      if (dirent.isDirectory()) await walk(abs);
      else if (dirent.isFile()) out.push(relative(root, abs).split(sep).join('/'));
    }
  }
  await walk(root);
  return out;
}

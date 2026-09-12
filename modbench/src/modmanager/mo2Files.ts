// MO2 files: the one writer of the instance (target-architecture.d2's `mo2files` box). A command
// splices a file's text through its own codec and puts the result through here.

import type { Dirent } from 'node:fs';
import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';

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
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return ifMissing;
  }
}

export interface PutOptions {
  /** A missing file reads as this text rather than rejecting. Omit to have a missing file
   *  refuse the write. */
  ifMissing?: string;
}

/** Whether `path`, file or directory, is there. */
export function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

/** `path`'s directory entries; the caller's own filter picks the ones it wants. */
export function listDir(path: string): Promise<Dirent[]> {
  return readdir(path, { withFileTypes: true });
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
 *  fires its watcher. Answers whether it wrote. */
export function putIfChanged(
  path: string, edit: (before: string) => string, opts: PutOptions = {},
): Promise<{ wrote: boolean }> {
  return withLock(path, async () => {
    const before = await readOr(path, opts.ifMissing);
    const after = edit(before);
    if (after === before) return { wrote: false };
    await writeFile(path, after);
    return { wrote: true };
  });
}

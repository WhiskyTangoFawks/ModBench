// VS Code's recursive watcher on Linux (@parcel/watcher's inotify backend) watches a folder it hears created, but can
// miss each folder already inside it, as when a tree moves in whole, and then hears no change there.

import { existsSync, watch, type FSWatcher } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { errorMessage } from '../ports/errorMessage';
import { ignoreSkippedLink, listFolders } from './files';

export interface HeldFolderWatch {
  /** Watches each folder, at any depth, that `folder` holds, while open; settles once each is watched. */
  created(folder: string): Promise<void>;
  /** Forgets `path` and everything under it. */
  removed(path: string): void;
  /** Watches again each folder held by every folder heard created before. */
  open(): Promise<void>;
  close(): void;
  /** Each distinct reason a folder's watch failed while open. */
  failures(): string[];
}

interface HeldFolderWatchDeps {
  onChange: (path: string) => void;
  /** Whether a change inside `folder` is one the watch hears. */
  holds: (folder: string) => boolean;
  onFailure: () => void;
}

/** Only a watch of everything beneath its base hears what a folder created in it holds. */
export function heldFolderWatchFor(glob: string, deps: HeldFolderWatchDeps): HeldFolderWatch | undefined {
  return process.platform === 'linux' && glob.endsWith('**') ? heldFolderWatch(deps) : undefined;
}

const isWithin = (folder: string, path: string): boolean => folder === path || folder.startsWith(`${path}${sep}`);

// Node names the folder in a watch error's message; without it, the reason is the same for every folder it fails on.
function reasonOf(error: unknown): string {
  const message = errorMessage(error);
  if (!(error instanceof Error) || !('syscall' in error) || !('path' in error)) return message;
  if (typeof error.syscall !== 'string' || typeof error.path !== 'string') return message;
  const naming = `, ${error.syscall} '${error.path}'`;
  return message.endsWith(naming) ? message.slice(0, -naming.length) : message;
}

// A link is followed as MO2 follows it, as `listFolders` lists it.
async function foldersIn(folder: string): Promise<string[]> {
  try {
    return (await listFolders(folder, ignoreSkippedLink)).map((name) => join(folder, name));
  } catch {
    return [];
  }
}

function heldFolderWatch({ onChange, holds, onFailure }: HeldFolderWatchDeps): HeldFolderWatch {
  const createdFolders = new Set<string>();
  const watched = new Map<string, { watcher: FSWatcher; real: string }>();
  const watchedReal = new Set<string>();
  const failed = new Map<string, string>();
  let isOpen = false;

  const forget = (folder: string): void => {
    const held = watched.get(folder);
    if (!held) return;
    held.watcher.close();
    watchedReal.delete(held.real);
    watched.delete(folder);
  };

  // A deletion can be heard after the folder is made again at the same path, and the folder made again is kept.
  const removed = (path: string): void => {
    if (existsSync(path)) return;
    for (const folder of watched.keys()) if (isWithin(folder, path)) forget(folder);
    for (const folder of createdFolders) if (isWithin(folder, path)) createdFolders.delete(folder);
    for (const folder of failed.keys()) if (isWithin(folder, path)) failed.delete(folder);
  };

  const fail = (folder: string, error: unknown): void => {
    forget(folder);
    failed.set(folder, reasonOf(error));
    onFailure();
  };

  // A watched folder deleted is heard by its own watch under its own name, and by its parent's.
  const heardIn = (folder: string, name: string | null): void => {
    if (!existsSync(folder)) {
      removed(folder);
      return;
    }
    const path = name === null ? folder : join(folder, name);
    onChange(path);
    void stat(path).then((facts) => (facts.isDirectory() ? watchFolder(path) : undefined), () => { removed(path); });
  };

  const passedOver = (folder: string): boolean => !isOpen || watched.has(folder);

  const watchHeldBy = async (folder: string): Promise<void> => {
    await watchAll(await foldersIn(folder));
  };

  // Watched before it is listed, so a folder made inside it meanwhile is heard or listed. A link back to a folder
  // already watched is not watched again, or a loop of links would be watched without end.
  const watchOne = async (folder: string): Promise<boolean> => {
    if (passedOver(folder) || !holds(folder)) return false;
    const real = await realpath(folder).catch(() => undefined);
    if (real === undefined || passedOver(folder) || watchedReal.has(real)) return false;
    try {
      const watcher = watch(folder, { persistent: false }, (_event, name) => { heardIn(folder, name); });
      watcher.on('error', (error) => { fail(folder, error); });
      watched.set(folder, { watcher, real });
      watchedReal.add(real);
      failed.delete(folder);
      return true;
    } catch (error) {
      fail(folder, error);
      return false;
    }
  };

  // A folder reached by two paths is watched under the shallower, and under the first listed of equal depth,
  // whatever the timing of the disk.
  const watchAll = async (folders: readonly string[]): Promise<void> => {
    const fresh: string[] = [];
    for (const folder of folders) if (await watchOne(folder)) fresh.push(folder);
    for (const folder of fresh) await watchHeldBy(folder);
  };

  const watchFolder = (folder: string): Promise<void> => watchAll([folder]);

  return {
    async created(folder) {
      if (!isOpen) return;
      const held = await foldersIn(folder);
      if (held.length > 0) createdFolders.add(folder);
      await watchAll(held);
    },
    removed,
    async open() {
      isOpen = true;
      await Promise.all([...createdFolders].map(watchHeldBy));
    },
    close() {
      isOpen = false;
      for (const folder of watched.keys()) forget(folder);
      failed.clear();
    },
    failures: () => [...new Set(failed.values())],
  };
}

// VS Code's recursive watcher on Linux (@parcel/watcher's inotify backend) watches a folder it hears created, but can
// miss each folder already inside it, as when a tree moves in whole, and then hears no change there.

import { existsSync, watch, type FSWatcher } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { errorMessage } from '../ports/errorMessage';
import { errnoCode } from '../ports/errno';
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

function heldFolderWatch({ onChange, holds, onFailure }: HeldFolderWatchDeps): HeldFolderWatch {
  const createdFolders = new Set<string>();
  const watched = new Map<string, { watcher: FSWatcher; real: string }>();
  const watchedReal = new Set<string>();
  const failed = new Map<string, string>();
  const listingFailed = new Map<string, string>();
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
    for (const folder of listingFailed.keys()) if (isWithin(folder, path)) listingFailed.delete(folder);
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
    void stat(path).then((facts) => (facts.isDirectory() ? watchLevel([path]) : undefined), () => { removed(path); });
  };

  const passedOver = (folder: string): boolean => !isOpen || watched.has(folder);

  const isGone = (error: unknown): boolean => ['ENOENT', 'ENOTDIR'].includes(errnoCode(error) ?? '');

  const foldersIn = async (folder: string): Promise<string[]> => {
    listingFailed.delete(folder);
    try {
      const names = await listFolders(folder, ignoreSkippedLink);
      return names.map((name) => join(folder, name));
    } catch (error) {
      if (isGone(error)) return [];
      listingFailed.set(folder, reasonOf(error));
      onFailure();
      return [];
    }
  };

  const realOf = async (folder: string): Promise<string | undefined> =>
    passedOver(folder) || !holds(folder) ? undefined : realpath(folder).catch((error: unknown) => {
        if (!isGone(error)) fail(folder, error);
        return undefined;
      });

  const register = (folder: string, real: string): boolean => {
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

  // A level is watched before the next, so a folder reached by two paths is watched under the shallower, and
  // under the first listed of equal depth, whatever the timing of the disk.
  const watchLevel = async (folders: readonly string[]): Promise<void> => {
    if (folders.length === 0) return;
    const reals = await Promise.all(folders.map(realOf));
    const fresh = folders.filter((folder, i) => {
      const real = reals[i];
      // A link back to a folder already watched is not watched again, or the walk would never end.
      return real !== undefined && !passedOver(folder) && !watchedReal.has(real) && register(folder, real);
    });
    // Each folder is watched before it is listed, so one created between the listing and the watch is not missed.
    await watchLevel((await Promise.all(fresh.map(foldersIn))).flat());
  };

  const watchHeldBy = async (folders: readonly string[]): Promise<void> => {
    await watchLevel((await Promise.all(folders.map(foldersIn))).flat());
  };

  return {
    async created(folder) {
      if (!isOpen) return;
      const held = await foldersIn(folder);
      if (held.length > 0) createdFolders.add(folder);
      await watchLevel(held);
    },
    removed,
    async open() {
      isOpen = true;
      await watchHeldBy([...createdFolders]);
    },
    close() {
      isOpen = false;
      for (const folder of watched.keys()) forget(folder);
      failed.clear();
      listingFailed.clear();
    },
    failures: () => [...new Set([...failed.values(), ...listingFailed.values()])],
  };
}

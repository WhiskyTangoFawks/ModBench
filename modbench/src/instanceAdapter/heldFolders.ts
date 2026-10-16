// VS Code's recursive watcher on Linux (@parcel/watcher's inotify backend) watches a folder it hears created, but can
// miss each folder already inside it, as when a tree moves in whole, and then hears no change there.

import { existsSync, watch, type FSWatcher } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { errorMessage } from '../ports/errorMessage';

export interface HeldFolderWatch {
  /** Watches each folder, at any depth, that `folder` holds, while open; settles once each is watched. */
  created(folder: string): Promise<void>;
  /** Watches again each folder held by every folder heard created before. */
  open(): Promise<void>;
  close(): void;
  /** Each folder whose watch failed, grouped by why; none while closed. */
  notes(): string[];
}

interface HeldFolderWatchDeps {
  onChange: (path: string) => void;
  /** Whether a change inside `folder` is one the watch hears. */
  holds: (folder: string) => boolean;
  onFailure: () => void;
}

async function subfoldersOf(folder: string): Promise<string[]> {
  try {
    return (await readdir(folder, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => join(folder, entry.name));
  } catch {
    return [];
  }
}

async function isFolder(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

const reasonOf = (error: unknown): string => (error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : errorMessage(error));

export function heldFolderWatch({ onChange, holds, onFailure }: HeldFolderWatchDeps): HeldFolderWatch {
  const createdFolders = new Set<string>();
  const watched = new Map<string, FSWatcher>();
  const failed = new Map<string, unknown>();
  let isOpen = false;

  const forget = (folder: string): void => {
    watched.get(folder)?.close();
    watched.delete(folder);
  };

  const fail = (folder: string, error: unknown): void => {
    forget(folder);
    if (!existsSync(folder)) return;
    failed.set(folder, error);
    onFailure();
  };

  const watchHeldBy = async (folder: string): Promise<void> => {
    await Promise.all((await subfoldersOf(folder)).map(watchFolder));
  };

  // Watched before it is listed, so a folder made inside it meanwhile is heard or listed.
  const watchFolder = async (folder: string): Promise<void> => {
    if (!isOpen || watched.has(folder) || !holds(folder)) return;
    try {
      const watcher = watch(folder, { persistent: false }, (_event, name) => {
        if (!existsSync(folder)) {
          forget(folder);
          return;
        }
        const path = name === null ? folder : join(folder, name);
        onChange(path);
        void isFolder(path).then((folderMade) => (folderMade ? watchFolder(path) : undefined));
      });
      watcher.on('error', (error) => { fail(folder, error); });
      watched.set(folder, watcher);
      failed.delete(folder);
    } catch (error) {
      fail(folder, error);
      return;
    }
    await watchHeldBy(folder);
  };

  return {
    async created(folder) {
      if (!isOpen) return;
      const held = await subfoldersOf(folder);
      if (held.length > 0) createdFolders.add(folder);
      await Promise.all(held.map(watchFolder));
    },
    async open() {
      isOpen = true;
      for (const folder of createdFolders) if (!existsSync(folder)) createdFolders.delete(folder);
      await Promise.all([...createdFolders].map(watchHeldBy));
    },
    close() {
      isOpen = false;
      for (const watcher of watched.values()) watcher.close();
      watched.clear();
      failed.clear();
    },
    notes() {
      const byReason = new Map<string, { first: string; error: unknown; count: number }>();
      for (const [folder, error] of failed) {
        if (!existsSync(folder)) {
          failed.delete(folder);
          continue;
        }
        const group = byReason.get(reasonOf(error));
        if (group) group.count++;
        else byReason.set(reasonOf(error), { first: folder, error, count: 1 });
      }
      return [...byReason.values()].map(({ first, error, count }) =>
        `Modbench hears no change inside ${count} folder(s), the first ${first}, whose watch failed: ${errorMessage(error)}`);
    },
  };
}

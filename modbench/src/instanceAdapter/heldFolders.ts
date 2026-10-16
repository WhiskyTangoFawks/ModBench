// VS Code's recursive watcher on Linux (@parcel/watcher's inotify backend) watches a folder it hears created, but can
// miss each folder already inside it, as when a tree moves in whole, and then hears no change there.

import { existsSync, watch, type FSWatcher } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface HeldFolderWatch {
  /** Watches each folder, at any depth, that `folder` holds; settles once each is watched. */
  created(folder: string): Promise<void>;
  dispose(): void;
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

export function heldFolderWatch(onChange: (path: string) => void): HeldFolderWatch {
  const watched = new Map<string, FSWatcher>();
  let disposed = false;

  const forget = (folder: string): void => {
    watched.get(folder)?.close();
    watched.delete(folder);
  };

  const watchHeldBy = async (folder: string): Promise<void> => {
    await Promise.all((await subfoldersOf(folder)).map(watchFolder));
  };

  // Watched before it is listed, so a folder made inside it meanwhile is heard or listed.
  const watchFolder = async (folder: string): Promise<void> => {
    if (disposed || watched.has(folder)) return;
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
      watcher.on('error', () => { forget(folder); });
      watched.set(folder, watcher);
    } catch {
      return;
    }
    await watchHeldBy(folder);
  };

  return {
    created: watchHeldBy,
    dispose() {
      disposed = true;
      for (const watcher of watched.values()) watcher.close();
      watched.clear();
    },
  };
}

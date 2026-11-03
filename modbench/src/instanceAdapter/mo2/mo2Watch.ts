// MO2's watch: every file of the instance, the downloads folder, the game folder's files Mod Management
// reads, armed through VS Code's file watcher while anyone listens, and a change to the game-folder setting.

import { heldFolderWatchFor, type HeldFolderWatch } from '../heldFolders';
import { watchFiles } from '../watchFiles';
import type { Subscription } from '../instanceAdapter';
import {
  MODLIST_GLOB, MODS_GLOB, OVERWRITE_GLOB, PLUGINS_GLOB, PROFILE_INIS_GLOB, HELD_BY_GIT_WATCH_GLOB, REPOSITORY_SET_UP_WATCH_GLOB, REPOSITORY_WATCH_GLOB, SETTINGS_WATCH_GLOB,
  SORTING_RULE_FILES_GLOB, SOURCE_GLOB,
} from './layout';

type FollowedFolder = 'downloadedFiles' | 'gameFolderPlugins' | 'creationClubList' | 'defaultIni' | 'myGamesInis' | 'gameFolderArchives' | 'gameFolderFiles';

// A repository's change is its working tree and its refs, never git's own bookkeeping.
function isRepositoryChange(path: string): boolean {
  const segments = path.split(/[\\/]/);
  const gitIndex = segments.lastIndexOf('.git');
  if (gitIndex === -1) return true;
  const [first, ...rest] = segments.slice(gitIndex + 1);
  if (first === undefined || first === 'refs') return true;
  return rest.length === 0 && (first === 'HEAD' || first === 'packed-refs');
}

interface Followed {
  readonly what: FollowedFolder;
  readonly base: string;
  readonly glob: string;
  watch?: Subscription;
}

export interface Mo2Watch {
  subscribe(listener: () => void): Subscription;
  /** Watches `base` under `glob` for `what` in place of the folder it followed before; undefined
   *  follows none. A watch newly armed signals once, for a change it missed while arming. */
  follow(what: FollowedFolder, base: string | undefined, glob: string): void;
  /** Whether `gameFolderFiles` may have changed since this last answered, or is not watched. */
  gameFolderFilesStale(): boolean;
  watchNotes(): string[];
}

export function mo2Watch(instanceRoot: string, gameFolderChanged: (listener: () => void) => Subscription): Mo2Watch {
  const listeners = new Set<() => void>();
  const followed = new Map<FollowedFolder, Followed>();
  let fixed: Subscription[] = [];
  // Kept across a disarm: a folder VS Code's watcher missed, it still misses once armed again.
  const held = new Map<string, HeldFolderWatch | undefined>();

  const changed = (): void => {
    for (const listener of [...listeners]) listener();
  };
  const onSourceChange = (path: string): void => {
    if (isRepositoryChange(path)) changed();
  };
  let gameFolderFilesChanged = true;
  const gameFolderFilesHeard = (): void => {
    gameFolderFilesChanged = true;
    changed();
  };
  const onChangeFor = (what: FollowedFolder | undefined, glob: string): ((path: string) => void) => {
    if (what === 'gameFolderFiles') return gameFolderFilesHeard;
    return glob === SOURCE_GLOB ? onSourceChange : changed;
  };
  const heldKey = (base: string, glob: string): string => `${base}\0${glob}`;
  const heldFor = (base: string, glob: string, what: FollowedFolder | undefined): HeldFolderWatch | undefined => {
    const key = heldKey(base, glob);
    if (!held.has(key)) {
      held.set(key, heldFolderWatchFor(glob, {
        onChange: onChangeFor(what, glob), holds: isRepositoryChange, onFailure: what === 'gameFolderFiles' ? gameFolderFilesHeard : changed,
      }));
    }
    return held.get(key);
  };
  const watch = (base: string, glob: string, what?: FollowedFolder): Subscription =>
    watchFiles(base, glob, onChangeFor(what, glob), heldFor(base, glob, what));
  const armed = (): boolean => listeners.size > 0;

  const arm = (): void => {
    fixed = [MODS_GLOB, OVERWRITE_GLOB, SOURCE_GLOB, MODLIST_GLOB, PLUGINS_GLOB, PROFILE_INIS_GLOB, SETTINGS_WATCH_GLOB, SORTING_RULE_FILES_GLOB, REPOSITORY_WATCH_GLOB, REPOSITORY_SET_UP_WATCH_GLOB, HELD_BY_GIT_WATCH_GLOB]
      .map((glob) => watch(instanceRoot, glob));
    fixed.push(gameFolderChanged(changed));
    gameFolderFilesChanged = true;
    for (const folder of followed.values()) folder.watch = watch(folder.base, folder.glob, folder.what);
  };
  const disarm = (): void => {
    for (const subscription of fixed) subscription.dispose();
    fixed = [];
    for (const folder of followed.values()) {
      folder.watch?.dispose();
      folder.watch = undefined;
    }
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) arm();
      return {
        dispose: () => {
          if (listeners.delete(listener) && listeners.size === 0) disarm();
        },
      };
    },

    gameFolderFilesStale() {
      const stale = gameFolderFilesChanged || !armed();
      gameFolderFilesChanged = false;
      return stale;
    },

    follow(what, base, glob) {
      const current = followed.get(what);
      if (current?.base === base) return;
      current?.watch?.dispose();
      if (current) held.delete(heldKey(current.base, current.glob));
      if (base === undefined) {
        followed.delete(what);
        if (what === 'gameFolderFiles') gameFolderFilesChanged = true;
        return;
      }
      const next: Followed = { what, base, glob };
      followed.set(what, next);
      if (what === 'gameFolderFiles') gameFolderFilesChanged = true;
      if (!armed()) return;
      next.watch = watch(base, glob, what);
      changed();
    },

    watchNotes: () => [...new Set([...held.values()].flatMap((folders) => folders?.failures() ?? []))]
      .map((reason) => `Modbench hears no change inside a folder whose watch failed: ${reason}`),
  };
}

// MO2's watch, armed while anyone listens: VS Code's file watcher on the instance, the downloads folder and the game
// folder's files Mod Management reads; the game-folder setting; VS Code's git.

import { join } from 'node:path';
import { pathKey } from '../../repositoriesLib/stampedReads';
import { GIT_DIR } from '../files';
import { heldFolderWatchFor, type HeldFolderWatch } from '../heldFolders';
import { watchFiles } from '../watchFiles';
import type { ChangeListener, Subscription, UnwatchedFolder, WatcherExclude } from '../instanceAdapter';
import { exclusionOf } from '../watcherExclusion';
import { followedFolders } from './followedFolders';
import { distinct, EXCLUDED, listedExclusions } from './listedExclusions';
import { FIRST_LEVEL, instanceWatches, sourceRootDir } from './layout';

type FollowedFolder = 'downloadedFiles' | 'dataFolder' | 'programs' | 'creationClubList' | 'defaultIni' | 'myGamesInis' | 'gameFolderArchives' | 'profileFolders' | 'excludedFolders' | 'pushCheck';

// A repository's change is its working tree and its refs, never git's own bookkeeping.
function isRepositoryChange(path: string): boolean {
  const segments = path.split(/[\\/]/);
  const gitIndex = segments.lastIndexOf('.git');
  if (gitIndex === -1) return true;
  const [first, ...rest] = segments.slice(gitIndex + 1);
  if (first === undefined || first === 'refs') return true;
  return rest.length === 0 && (first === 'HEAD' || first === 'packed-refs');
}

export interface Mo2Watch {
  subscribe(listener: ChangeListener): Subscription;
  /** Watches each of `bases` under `glob` for `what`, in place of the folders it followed before. A watch newly armed has
   *  the disk checked once, for a change it missed while arming. */
  follow(what: FollowedFolder, bases: readonly string[], glob: string): void;
  /** The folders and files a read of `key` listed, in place of what it listed before; `undefined` once it lists none. */
  listed(key: string, listing: { readonly folders: readonly string[]; readonly files: readonly string[] } | undefined): void;
  unwatchedFolders(): UnwatchedFolder[];
}

export function mo2Watch(
  instanceRoot: string, gameFolderChanged: (listener: () => void) => Subscription, repositoryChanged: (listener: (path: string) => void) => Subscription,
  exclusion: WatcherExclude,
): Mo2Watch {
  const listeners = new Set<ChangeListener>();
  let fixed: Subscription[] = [];
  // Kept across a disarm: a folder VS Code's watcher missed, it still misses once armed again.
  const held = new Map<string, HeldFolderWatch | undefined>();
  const sources = sourceRootDir(instanceRoot);

  const changed: ChangeListener = (path) => {
    for (const listener of [...listeners]) listener(path);
  };
  const checkDue = (): void => { changed(undefined); };
  const onSourceChange = (path: string): void => {
    if (isRepositoryChange(path)) changed(path);
  };
  // A write inside .git can report the folder itself changed, as Windows does; only its making or removal is the root's.
  const dotGit = pathKey(join(instanceRoot, GIT_DIR));
  const onRootChange = (path: string, asChanged = false): void => {
    if (!asChanged || pathKey(path) !== dotGit) changed(path);
  };
  const onChangeFor = (base: string): ((path: string, asChanged?: boolean) => void) =>
    (base === sources ? onSourceChange : base === instanceRoot ? onRootChange : changed);
  const heldKey = (base: string, glob: string): string => `${base}\0${glob}`;
  const heldFor = (base: string, glob: string): HeldFolderWatch | undefined => {
    const key = heldKey(base, glob);
    if (!held.has(key)) held.set(key, heldFolderWatchFor(glob, { onChange: onChangeFor(base), holds: isRepositoryChange, onFailure: checkDue }));
    return held.get(key);
  };
  let excluding = exclusionOf(exclusion.value(), instanceRoot);
  const dropsEvents = (base: string, glob: string): boolean => glob.includes('**') && excluding.excludesFolder(base);
  const watch = (base: string, glob: string): Subscription => {
    // VS Code's watch of everything beneath a base drops a folder the user excluded; its first level it still hears.
    const reached = dropsEvents(base, glob) ? FIRST_LEVEL : glob;
    return watchFiles(base, reached, onChangeFor(base), heldFor(base, reached));
  };
  const followed = followedFolders({ watch, armed: () => listeners.size > 0, checkDue, forget: (base, glob) => { held.delete(heldKey(base, glob)); } });

  const listings = listedExclusions(() => excluding, instanceWatches(instanceRoot).map(({ base }) => base));
  const followExcludedFolders = (): void => { followed.follow('excludedFolders', listings.excludedFolders(), FIRST_LEVEL); };

  const arm = (): void => {
    fixed = instanceWatches(instanceRoot).map(({ base, pattern }) => watch(base, pattern));
    fixed.push(gameFolderChanged(checkDue), repositoryChanged(changed), exclusion.changed(() => {
      disarm();
      excluding = exclusionOf(exclusion.value(), instanceRoot);
      listings.judgedAgain();
      arm();
      followExcludedFolders();
      checkDue();
    }));
    followed.arm();
  };
  const disarm = (): void => {
    for (const subscription of fixed) subscription.dispose();
    fixed = [];
    followed.disarm();
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

    follow: followed.follow,

    listed(key, listing) {
      listings.set(key, listing);
      followExcludedFolders();
    },

    unwatchedFolders: () => distinct([
      ...instanceWatches(instanceRoot).filter(({ base, pattern }) => dropsEvents(base, pattern)).map(({ base }) => ({ folder: base, reason: EXCLUDED })),
      ...followed.entries().filter(({ base, glob }) => dropsEvents(base, glob)).map(({ base }) => ({ folder: base, reason: EXCLUDED })),
      ...listings.named(),
      ...[...held.values()].flatMap((folders) => folders?.failures() ?? []),
    ]),
  };
}

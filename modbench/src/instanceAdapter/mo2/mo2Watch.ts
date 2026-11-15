// MO2's watch, armed while anyone listens: VS Code's file watcher on the instance, the downloads folder and the game
// folder's files Mod Management reads; the game-folder setting; VS Code's git.

import { heldFolderWatchFor, type HeldFolderWatch } from '../heldFolders';
import { watchFiles } from '../watchFiles';
import { outsideTrustedRead } from '../files';
import type { ChangeListener, Subscription, UnwatchedFolder, WatcherExclude } from '../instanceAdapter';
import { excludesFolder } from '../watcherExclusion';
import { FIRST_LEVEL, instanceWatches, sourceRootDir } from './layout';

type FollowedFolder = 'downloadedFiles' | 'dataFolder' | 'programs' | 'creationClubList' | 'defaultIni' | 'myGamesInis' | 'gameFolderArchives' | 'modFolders' | 'profileFolders';

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
  readonly glob: string;
  readonly watches: ReadonlyMap<string, Subscription | undefined>;
}

export interface Mo2Watch {
  subscribe(listener: ChangeListener): Subscription;
  /** Watches each of `bases` under `glob` for `what`, in place of the folders it followed before. A watch newly armed has
   *  the disk checked once, for a change it missed while arming. */
  follow(what: FollowedFolder, bases: readonly string[], glob: string): void;
  unwatchedFolders(): UnwatchedFolder[];
}

const EXCLUDED = 'excluded in files.watcherExclude';

export function mo2Watch(
  instanceRoot: string, gameFolderChanged: (listener: () => void) => Subscription, repositoryChanged: (listener: (path: string) => void) => Subscription,
  exclusion: WatcherExclude,
): Mo2Watch {
  const listeners = new Set<ChangeListener>();
  const followed = new Map<FollowedFolder, Followed>();
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
  const onChangeFor = (base: string): ((path: string) => void) => (base === sources ? onSourceChange : changed);
  const heldKey = (base: string, glob: string): string => `${base}\0${glob}`;
  const heldFor = (base: string, glob: string): HeldFolderWatch | undefined => {
    const key = heldKey(base, glob);
    if (!held.has(key)) held.set(key, heldFolderWatchFor(glob, { onChange: onChangeFor(base), holds: isRepositoryChange, onFailure: checkDue }));
    return held.get(key);
  };
  const excluded = (base: string): boolean => excludesFolder(exclusion.value(), base, instanceRoot);
  // VS Code's watch of everything beneath a base drops the events of a folder the user excluded; the first level of one it still hears.
  const dropsEvents = (base: string, glob: string): boolean => glob.includes('**') && excluded(base);
  const watch = (base: string, glob: string): Subscription => {
    const reached = dropsEvents(base, glob) ? FIRST_LEVEL : glob;
    return watchFiles(base, reached, onChangeFor(base), heldFor(base, reached));
  };
  const armed = (): boolean => listeners.size > 0;
  const rearmed = ({ glob, watches }: Followed, arming: (base: string) => Subscription | undefined): Followed => {
    for (const watching of watches.values()) watching?.dispose();
    return { glob, watches: new Map([...watches.keys()].map((base) => [base, arming(base)])) };
  };

  const arm = (): void => {
    fixed = instanceWatches(instanceRoot).map(({ base, pattern }) => watch(base, pattern));
    fixed.push(gameFolderChanged(checkDue), repositoryChanged(changed), exclusion.changed(() => { disarm(); arm(); checkDue(); }));
    for (const [what, folders] of followed) followed.set(what, rearmed(folders, (base) => watch(base, folders.glob)));
  };
  const disarm = (): void => {
    for (const subscription of fixed) subscription.dispose();
    fixed = [];
    for (const [what, folders] of followed) followed.set(what, rearmed(folders, () => undefined));
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

    // A read that follows a folder trusts what it keeps; what the watch arms, and the listeners it calls, never do.
    follow: (what, requested, glob) => outsideTrustedRead(() => {
      const wanted = what === 'modFolders' ? requested.filter(excluded) : requested;
      const before: Followed = followed.get(what) ?? { glob, watches: new Map<string, Subscription | undefined>() };
      const kept = new Set(before.glob === glob ? wanted : []);
      const watches = new Map<string, Subscription | undefined>();
      for (const [base, watching] of before.watches) {
        if (kept.has(base)) watches.set(base, watching);
        else {
          watching?.dispose();
          held.delete(heldKey(base, before.glob));
        }
      }
      const added = wanted.filter((base) => !watches.has(base));
      for (const base of added) watches.set(base, armed() ? watch(base, glob) : undefined);
      followed.set(what, { glob, watches });
      if (added.length > 0 && armed()) checkDue();
    }),

    unwatchedFolders: () => [
      ...instanceWatches(instanceRoot).filter(({ base, pattern }) => dropsEvents(base, pattern)).map(({ base }) => ({ folder: base, reason: EXCLUDED })),
      ...[...followed].flatMap(([what, { glob, watches }]) => [...watches.keys()].filter((base) => what === 'modFolders' || dropsEvents(base, glob)))
        .map((folder) => ({ folder, reason: EXCLUDED })),
      ...[...held.values()].flatMap((folders) => folders?.failures() ?? []),
    ],
  };
}

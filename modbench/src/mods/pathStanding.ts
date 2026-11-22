// source.md, Editing plugin source, story 1: what holds a path a plugin source names.

import type { InstanceValue } from '../instanceLoader/instance';
import { changedKeys } from '../ports/lastBuilt';
import { SOURCE_FILES_READ } from '../instanceLoader/loadOrderSnapshot';
import { OVERWRITE_ORIGIN } from '../wire/pluginAddress';
import { gameReleaseForGame, pathsTheGameTries } from '../tables/gamePaths';
import { copyTheGameGets } from './fileCopy';

const STANDING_READ = {
  stackedCopies: true, dataFolderFiles: true, gameFolderArchived: true, gameFolderInWorkspace: true, gameFolder: true, filesByMod: true, overwriteFiles: true,
  archiveContents: true, gameName: true,
} as const;
type StandingValue = Pick<InstanceValue, keyof typeof STANDING_READ>;

function modHolds(value: StandingValue, origin: string, folded: string): boolean {
  const files = origin === OVERWRITE_ORIGIN ? value.overwriteFiles : value.filesByMod.get(origin) ?? [];
  return files.some(({ relativePath, sourcePath }) => {
    const archived = value.archiveContents.get(sourcePath);
    return relativePath.toLowerCase() === folded || (archived?.kind === 'read' && archived.answer.some((entry) => entry.toLowerCase() === folded));
  });
}

// The path problems this tells judge each plugin source by its standing and by where `sourceFiles` finds its files.
const JUDGED_READ = { ...STANDING_READ, ...SOURCE_FILES_READ } as const;
type JudgedValue = Pick<InstanceValue, keyof typeof JUDGED_READ>;

// What a new value changed of what the instance says of files: the origins whose files changed, and each path, folded, they
// hold or held; or anything.
type StandingChanged = 'every' | { readonly origins: ReadonlySet<string>; readonly paths: ReadonlySet<string> };

const BY_FILES: readonly string[] = ['filesByMod', 'overwriteFiles', 'stackedCopies'];

function standingChanged(before: JudgedValue, after: JudgedValue): StandingChanged {
  const isJudged = (fact: string): fact is keyof JudgedValue => fact in JUDGED_READ;
  if (Object.keys(JUDGED_READ).filter(isJudged).some((fact) => !BY_FILES.includes(fact) && before[fact] !== after[fact])) return 'every';
  const mods = changedKeys(after.filesByMod, before.filesByMod);
  const overwrite = before.overwriteFiles !== after.overwriteFiles;
  if (mods.length === 0 && !overwrite) return before.stackedCopies === after.stackedCopies ? { origins: new Set(), paths: new Set() } : 'every';
  const files = [...mods.flatMap((name) => [...before.filesByMod.get(name) ?? [], ...after.filesByMod.get(name) ?? []]), ...overwrite ? [...before.overwriteFiles, ...after.overwriteFiles] : []];
  return { origins: new Set([...mods, ...overwrite ? [OVERWRITE_ORIGIN] : []]), paths: new Set(files.map(({ relativePath }) => relativePath.toLowerCase())) };
}

const triedPathsIn = (gameName: string, dataPath: string): readonly string[] => pathsTheGameTries(gameReleaseForGame(gameName), dataPath.replaceAll('\\', '/'));

export function pathStandingOf(instance: {
  readonly value: StandingValue; subscribe: (listener: (value: JudgedValue) => void, concerns: typeof JUDGED_READ) => { dispose: () => unknown };
}) {
  return {
    judged: (): boolean => instance.value.gameFolder.kind === 'found' && instance.value.gameFolderInWorkspace,
    holds: ({ origin }: { origin: string }, dataPath: string): boolean => {
      const { value } = instance;
      return triedPathsIn(value.gameName, dataPath).some((path) => !('none' in copyTheGameGets(value, path)) || modHolds(value, origin, path.toLowerCase()));
    },
    /** Each path, folded, the game tries for `dataPath`: `holds` answers by these alone, with its plugin's mod. */
    triedPaths: (dataPath: string): string[] => triedPathsIn(instance.value.gameName, dataPath).map((path) => path.toLowerCase()),
    subscribe: (listener: (changed: StandingChanged) => void) => {
      let held: JudgedValue | undefined;
      return instance.subscribe((value) => {
        const changed = held === undefined ? 'every' : standingChanged(held, value);
        held = value;
        listener(changed);
      }, JUDGED_READ);
    },
  };
}

export const NO_PATH_STANDING: ReturnType<typeof pathStandingOf> = {
  judged: () => false, holds: () => false, triedPaths: () => [], subscribe: () => ({ dispose: () => undefined }),
};

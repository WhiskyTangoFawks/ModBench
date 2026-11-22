// source.md, Editing plugin source, story 1: what holds a path a plugin source names.

import type { InstanceValue } from '../instanceLoader/instance';
import { filesChanged, TOUCHING_READ, type FilesChanged } from '../instanceLoader/filesChanged';
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

// The path problems this tells judge each plugin source by its standing, by where `sourceFiles` finds its files, and by
// what a change did to the origins' files.
const JUDGED_READ = { ...STANDING_READ, ...SOURCE_FILES_READ, ...TOUCHING_READ } as const;
type JudgedValue = Pick<InstanceValue, keyof typeof JUDGED_READ>;

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
    subscribe: (listener: (changed: FilesChanged) => void) => {
      let held: JudgedValue | undefined;
      return instance.subscribe((value) => {
        const changed = filesChanged(held, value, JUDGED_READ);
        held = value;
        listener(changed);
      }, JUDGED_READ);
    },
  };
}

export const NO_PATH_STANDING: ReturnType<typeof pathStandingOf> = {
  judged: () => false, holds: () => false, triedPaths: () => [], subscribe: () => ({ dispose: () => undefined }),
};

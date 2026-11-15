// source.md, Editing plugin source, story 1: what holds a path a plugin source names.

import type { InstanceValue } from '../instanceLoader/instance';
import { SOURCE_FILES_READ } from '../instanceLoader/loadOrderSnapshot';
import { OVERWRITE_ORIGIN } from '../wire/pluginAddress';
import { copyTheGameGets } from './fileCopy';

const STANDING_READ = {
  stackedCopies: true, dataFolderFiles: true, gameFolderArchived: true, gameFolderInWorkspace: true, gameFolder: true, filesByMod: true, overwriteFiles: true,
  archiveContents: true,
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

export function pathStandingOf(instance: {
  readonly value: StandingValue; subscribe: (listener: () => void, concerns: typeof JUDGED_READ) => { dispose: () => unknown };
}) {
  return {
    judged: (): boolean => instance.value.gameFolder.kind === 'found' && instance.value.gameFolderInWorkspace,
    holds: ({ origin }: { origin: string }, dataPath: string): boolean => {
      const path = dataPath.replaceAll('\\', '/');
      return !('none' in copyTheGameGets(instance.value, path)) || modHolds(instance.value, origin, path.toLowerCase());
    },
    subscribe: (listener: () => void) => instance.subscribe(listener, JUDGED_READ),
  };
}

export const NO_PATH_STANDING: ReturnType<typeof pathStandingOf> = { judged: () => false, holds: () => false, subscribe: () => ({ dispose: () => undefined }) };

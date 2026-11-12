// source.md, In the text editor, story 6: what holds a path a plugin source names.

import type { InstanceValue } from '../instanceLoader/instance';
import { OVERWRITE_ORIGIN } from '../wire/pluginAddress';
import { copyTheGameGets } from './fileCopy';

type StandingValue = Pick<InstanceValue, 'stackedCopies' | 'dataFolderFiles' | 'gameFolderArchived' | 'gameFolderInWorkspace' | 'gameFolder' | 'filesByMod' | 'overwriteFiles' | 'archiveContents'>;

function modHolds(value: StandingValue, origin: string, folded: string): boolean {
  const files = origin === OVERWRITE_ORIGIN ? value.overwriteFiles : value.filesByMod.get(origin) ?? [];
  return files.some(({ relativePath, sourcePath }) => {
    const archived = value.archiveContents.get(sourcePath);
    return relativePath.toLowerCase() === folded || (archived?.kind === 'read' && archived.answer.some((entry) => entry.toLowerCase() === folded));
  });
}

export function pathStandingOf(instance: { readonly value: StandingValue; subscribe: (listener: () => void) => { dispose: () => unknown } }) {
  return {
    judged: (): boolean => instance.value.gameFolder.kind === 'found' && instance.value.gameFolderInWorkspace,
    holds: ({ origin }: { origin: string }, dataPath: string): boolean => {
      const path = dataPath.replaceAll('\\', '/');
      return !('none' in copyTheGameGets(instance.value, path)) || modHolds(instance.value, origin, path.toLowerCase());
    },
    subscribe: (listener: () => void) => instance.subscribe(listener),
  };
}

export const NO_PATH_STANDING: ReturnType<typeof pathStandingOf> = { judged: () => false, holds: () => false, subscribe: () => ({ dispose: () => undefined }) };

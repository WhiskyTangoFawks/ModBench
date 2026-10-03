// MO2's exclusion of a file: the file or folder renamed with MO2's suffix, or restored.

import { exists, rename, withLock } from './files';
import type { InstanceAdapter, OriginFileMark } from './instanceAdapter';
import { excludedName, fileInFolder, includedName, isExcludedName, originDir } from './layout';
import type { Mo2Context } from './mo2Context';

export type Mo2OriginFiles = Pick<InstanceAdapter, 'markOriginFile'>;

function fileUnder(folder: string | undefined, relativePath: string): string | undefined {
  const reachesOut = relativePath.split('/').some((segment) => ['', '.', '..'].includes(segment) || segment.includes('\\'));
  return folder === undefined || reachesOut ? undefined : fileInFolder(folder, relativePath);
}

export function mo2OriginFiles({ instanceRoot }: Mo2Context): Mo2OriginFiles {
  return {
    async markOriginFile(origin, relativePath, mark: OriginFileMark) {
      const from = fileUnder(originDir(instanceRoot, origin), relativePath);
      if (from === undefined) throw new Error(`Not a file of ${origin.kind === 'mod' ? `mod "${origin.name}"` : 'Overwrite'}: "${relativePath}"`);
      return withLock(from, async () => {
        if (!(await exists(from))) return { gone: true };
        if (mark === 'Included' && relativePath.split('/').slice(0, -1).some(isExcludedName)) {
          throw new Error(`"${relativePath}" is excluded by its folder: include the folder instead`);
        }
        if (isExcludedName(from) === (mark === 'Excluded')) return { gone: false, wrote: false };
        const to = mark === 'Excluded' ? excludedName(from) : includedName(from);
        if (await exists(to)) throw new Error(`"${to}" is already there`);
        await rename(from, to);
        return { gone: false, wrote: true };
      });
    },
  };
}

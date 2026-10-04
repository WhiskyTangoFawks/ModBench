// MO2's exclusion of a file: the file or folder renamed with MO2's suffix, or restored.

import { exists, rename, withLock } from './files';
import type { InstanceAdapter, OriginFileMark, OriginFileMarked } from './instanceAdapter';
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
      return withLock(from, async (): Promise<OriginFileMarked> => {
        if (!(await exists(from))) return { gone: true };
        const ownMark = isExcludedName(relativePath);
        if (mark === 'Included' && !ownMark && relativePath.split('/').slice(0, -1).some(isExcludedName)) {
          return { gone: false, refusal: `"${relativePath}" has no suffix of its own to remove, and its folder excludes it.` };
        }
        if (ownMark === (mark === 'Excluded')) return { gone: false, wrote: false, relativePath };
        const renamed = mark === 'Excluded' ? excludedName : includedName;
        const to = renamed(from);
        if (await exists(to)) return { gone: false, refusal: `"${renamed(relativePath)}" is already there.` };
        await rename(from, to);
        return { gone: false, wrote: true, relativePath: renamed(relativePath) };
      });
    },
  };
}

// MO2's exclusion of a file, the file or folder renamed with MO2's suffix or restored, and a mod's file sent to the trash.

import { isAbsolute, relative, sep } from 'node:path';
import { exists, realPathIfThere, rename, withLock } from '../files';
import { fileInFolder, type InstanceAdapter, OriginFileMark, OriginFileMarked } from '../instanceAdapter';
import { EXCLUDED_SUFFIX, excludedName, includedName, isExcludedName } from './layout';
import { originFolder, type Mo2Context } from './mo2Context';

type Mo2OriginFiles = Pick<InstanceAdapter, 'markOriginFile' | 'trashModFile' | 'includedPath' | 'excludedSuffix'>;

function fileUnder(folder: string | undefined, relativePath: string): string | undefined {
  const reachesOut = relativePath.split('/').some((segment) => ['', '.', '..'].includes(segment) || segment.includes('\\'));
  return folder === undefined || reachesOut ? undefined : fileInFolder(folder, relativePath);
}

export function mo2OriginFiles(context: Mo2Context): Mo2OriginFiles {
  return {
    async markOriginFile(origin, relativePath, mark: OriginFileMark) {
      const from = fileUnder(await originFolder(context, origin, 'list'), relativePath);
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

    async trashModFile(mod, relativePath, trash) {
      const folder = await originFolder(context, { kind: 'mod', name: mod }, 'list');
      const file = fileUnder(folder, relativePath);
      const notAFile = new Error(`Not a file of mod "${mod}": "${relativePath}"`);
      if (folder === undefined || file === undefined) throw notAFile;
      const real = await realPathIfThere(file);
      if (real === undefined) return;
      const inFolder = relative(await realPathIfThere(folder) ?? folder, real);
      if (isAbsolute(inFolder) || inFolder.split(sep)[0] === '..') throw notAFile;
      await trash(file);
    },

    excludedSuffix: EXCLUDED_SUFFIX,

    includedPath: (relativePath) =>
      relativePath.split('/').map((segment) => (isExcludedName(segment) ? includedName(segment) : segment)).join('/'),
  };
}

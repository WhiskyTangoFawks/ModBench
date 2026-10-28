// MO2's exclusion of a file, the file or folder renamed with MO2's suffix or restored, and a mod's file sent to the trash.

import { isAbsolute, relative, sep } from 'node:path';
import { errnoCode } from '../../ports/errno';
import { exists, factsOf, realPathIfThere, rename, withLock } from '../files';
import { fileInFolder, type FileOrigin, type InstanceAdapter, OriginFileMark, OriginFileMarked } from '../instanceAdapter';
import { EXCLUDED_SUFFIX, excludedName, includedName, isExcludedName } from './layout';
import { originFileOf } from './mo2Files';
import { originFolder, type Mo2Context } from './mo2Context';

type Mo2OriginFiles = Pick<InstanceAdapter, 'originFile' | 'markOriginFile' | 'trashModFile' | 'exclusionMark'>;

function fileUnder(folder: string | undefined, relativePath: string): string | undefined {
  const reachesOut = relativePath.split('/').some((segment) => ['', '.', '..'].includes(segment) || segment.includes('\\'));
  return folder === undefined || reachesOut ? undefined : fileInFolder(folder, relativePath);
}

async function pathOf(context: Mo2Context, origin: FileOrigin, relativePath: string): Promise<string> {
  const path = fileUnder(await originFolder(context, origin, 'list'), relativePath);
  if (path === undefined) throw new Error(`Not a file of ${origin.kind === 'mod' ? `mod "${origin.name}"` : 'Overwrite'}: "${relativePath}"`);
  return path;
}

export function mo2OriginFiles(context: Mo2Context): Mo2OriginFiles {
  return {
    async originFile(origin, relativePath) {
      const path = await pathOf(context, origin, relativePath);
      try {
        const facts = await factsOf(path);
        return facts.kind === 'file' ? originFileOf(relativePath, path, facts.realPath) : undefined;
      } catch (err) {
        if (errnoCode(err) === 'ENOENT') return undefined;
        throw err;
      }
    },

    async markOriginFile(origin, relativePath, mark: OriginFileMark) {
      const from = await pathOf(context, origin, relativePath);
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

    exclusionMark: EXCLUDED_SUFFIX,
  };
}

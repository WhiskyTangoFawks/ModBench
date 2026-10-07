// How MO2's implementation lands a mod: extracted inside the mod's own folder, then settled as its
// contents. An upgrade replaces the folder's contents in place.

import { parseMetaIni, setOwnedKeysInText, writeMetaIni } from './codecs/metaIni';
import { copyTree, ensureDir, get, listDir, makeDir, makeTempDir, remove, rename, write } from './files';
import type { ExtractedEntry, InstanceAdapter, ModMeta, OwnedMetaKeys } from './instanceAdapter';
import {
  fileInFolder, isRepositoryOrPluginSource, modMetaFileIn, modsDir, newModExtractionPrefix, upgradeExtractionPrefix,
} from './layout';
import { errnoCode } from '../ports/errno';
import { folderHolding, newModFolder, refuseFolderTaken, type Mo2Context } from './mo2Context';

type Mo2Landing = Pick<InstanceAdapter, 'extractNewMod' | 'extractUpgrade' | 'extractedEntries'>;

// A key the upgrade does not supply keeps the carried meta's own value.
function keysOver(keys: OwnedMetaKeys, carried: ModMeta): OwnedMetaKeys {
  return {
    gameName: keys.gameName,
    nexusId: keys.nexusId ?? carried.nexusId,
    version: keys.version ?? carried.version,
    archiveFilename: keys.archiveFilename ?? carried.archiveFilename,
    installedFiles: keys.installedFiles ?? carried.installedFiles,
  };
}

// The release's root entries move up into the mod's folder; the rest of the extraction goes.
async function settleInto(folder: string, extraction: string, root: string, metaText: string): Promise<void> {
  for (const { name } of await listDir(root)) await rename(fileInFolder(root, name), fileInFolder(folder, name));
  await remove(extraction);
  await write(modMetaFileIn(folder), metaText);
}

export function mo2Landing(context: Mo2Context): Mo2Landing {
  return {
    async extractNewMod(mod) {
      const folder = newModFolder(context, mod);
      await refuseFolderTaken(context, { kind: 'mod', name: mod }, folder);
      await ensureDir(modsDir(context.instanceRoot));
      try {
        await makeDir(folder);
      } catch (err) {
        if (errnoCode(err) === 'EEXIST') throw new Error(`The folder "${folder}" is in the way`, { cause: err });
        throw err;
      }
      const path = await makeTempDir(newModExtractionPrefix(folder));
      return {
        path,
        copyIn: (source) => copyTree(source, path),
        land: (root, keys) => settleInto(folder, path, root, writeMetaIni(keys)),
        abandon: () => remove(folder),
      };
    },

    async extractUpgrade(mod) {
      const folder = (await folderHolding(context, { kind: 'mod', name: mod }))?.path;
      if (folder === undefined) throw new Error(`No folder holds the mod "${mod}"`);
      const path = await makeTempDir(upgradeExtractionPrefix(folder));
      return {
        path,
        copyIn: (source) => copyTree(source, path),
        async land(root, keys) {
          const repositoryOrPluginSourceEntry = (await listDir(root)).map((d) => d.name).find(isRepositoryOrPluginSource);
          if (repositoryOrPluginSourceEntry !== undefined) return { refused: true, repositoryOrPluginSourceEntry };
          const carried = await get(modMetaFileIn(folder), '');
          for (const { name } of await listDir(folder)) {
            const entry = fileInFolder(folder, name);
            if (entry !== path && !isRepositoryOrPluginSource(name)) await remove(entry);
          }
          await settleInto(folder, path, root, setOwnedKeysInText(carried, keysOver(keys, parseMetaIni(carried))));
          return { refused: false };
        },
        abandon: () => remove(path),
      };
    },

    async extractedEntries(folder) {
      return (await listDir(folder)).map((d): ExtractedEntry => ({
        name: d.name, kind: d.isDirectory() ? 'folder' : d.isFile() ? 'file' : 'other',
      }));
    },
  };
}

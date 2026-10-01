// How MO2's implementation lands a mod: extracted inside the mod's own folder, then settled as its
// contents. An upgrade replaces the folder's contents in place.

import { parseMetaIni, setOwnedKeysInText, writeMetaIni } from './codecs/metaIni';
import { copyTree, ensureDir, get, listDir, makeTempDir, remove, rename, write } from './files';
import type { ExtractedEntry, InstanceAdapter, ModExtraction, ModMeta, OwnedMetaKeys, Upgraded } from './instanceAdapter';
import { extractionPrefix, fileInFolder, isRepositoryOrPluginSource, modMetaFileIn } from './layout';
import { folderHolding, newModFolder, refuseFolderTaken, type Mo2Context } from './mo2Context';

export type Mo2Landing = Pick<InstanceAdapter, 'extractNewMod' | 'extractUpgrade' | 'extractedEntries'>;

// A key the upgrade does not supply keeps the carried meta's own value.
function keysOver(keys: OwnedMetaKeys, carried: ModMeta): OwnedMetaKeys {
  return {
    gameName: keys.gameName,
    modid: keys.modid ?? carried.nexusId,
    version: keys.version ?? carried.version,
    installationFile: keys.installationFile ?? carried.archiveFilename,
    installedFiles: keys.installedFiles ?? carried.installedFiles,
  };
}

async function moveEntriesUp(from: string, into: string): Promise<void> {
  for (const { name } of await listDir(from)) await rename(fileInFolder(from, name), fileInFolder(into, name));
}

async function extractionIn(
  folder: string,
  land: (extraction: string, root: string, keys: OwnedMetaKeys) => Promise<Upgraded>,
  abandon: (extraction: string) => Promise<void>,
): Promise<ModExtraction> {
  const path = await makeTempDir(extractionPrefix(folder));
  return {
    path,
    copyIn: (source) => copyTree(source, path),
    land: (root, keys) => land(path, root, keys),
    abandon: () => abandon(path),
  };
}

export function mo2Landing(context: Mo2Context): Mo2Landing {
  return {
    async extractNewMod(mod) {
      const folder = newModFolder(context, mod);
      await refuseFolderTaken(context, { kind: 'mod', name: mod }, folder);
      await ensureDir(folder);
      return extractionIn(
        folder,
        async (extraction, root, keys) => {
          await moveEntriesUp(root, folder);
          await remove(extraction);
          await write(modMetaFileIn(folder), writeMetaIni(keys));
          return { refused: false };
        },
        () => remove(folder),
      );
    },

    async extractUpgrade(mod) {
      const folder = (await folderHolding(context, { kind: 'mod', name: mod }))?.path;
      if (folder === undefined) throw new Error(`No folder holds the mod "${mod}"`);
      return extractionIn(
        folder,
        async (extraction, root, keys) => {
          const repositoryOrPluginSourceEntry = (await listDir(root)).map((d) => d.name).find(isRepositoryOrPluginSource);
          if (repositoryOrPluginSourceEntry !== undefined) return { refused: true, repositoryOrPluginSourceEntry };
          const carried = await get(modMetaFileIn(folder), '');
          for (const { name } of await listDir(folder)) {
            const path = fileInFolder(folder, name);
            if (path !== extraction && !isRepositoryOrPluginSource(name)) await remove(path);
          }
          await moveEntriesUp(root, folder);
          await remove(extraction);
          await write(modMetaFileIn(folder), setOwnedKeysInText(carried, keysOver(keys, parseMetaIni(carried))));
          return { refused: false };
        },
        remove,
      );
    },

    async extractedEntries(folder) {
      return (await listDir(folder)).map((d): ExtractedEntry => ({
        name: d.name, kind: d.isDirectory() ? 'folder' : d.isFile() ? 'file' : 'other',
      }));
    },
  };
}

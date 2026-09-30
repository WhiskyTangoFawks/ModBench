// How MO2's implementation lands a mod: staged beside the mod folders, then one rename into place,
// or an upgrade that replaces a folder's contents in place.

import { parseMetaIni, setOwnedKeysInText, writeMetaIni } from './codecs/metaIni';
import { ensureDir, get, listDir, makeTempDir, remove, rename, write } from './files';
import type { InstanceAdapter, ModMeta, OwnedMetaKeys } from './instanceAdapter';
import { fileInFolder, modMetaFileIn, modsDir, stagingPrefix } from './layout';
import { modFolderOf, type Mo2Context } from './mo2Context';

export type Mo2Landing = Pick<InstanceAdapter, 'stagingFolder' | 'landNewMod' | 'upgradeMod'>;

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

export function mo2Landing(context: Mo2Context): Mo2Landing {
  const { instanceRoot } = context;
  return {
    stagingFolder: () => makeTempDir(stagingPrefix(instanceRoot)),

    async landNewMod(mod, staged, keys) {
      const folder = modFolderOf(context, mod);
      await write(modMetaFileIn(staged), writeMetaIni(keys));
      await ensureDir(modsDir(instanceRoot));
      await rename(staged, folder);
    },

    // The meta the mod had is read before its contents go, so its own keys survive the release.
    async upgradeMod(mod, staged, keys, keep) {
      const folder = modFolderOf(context, mod);
      const carried = await get(modMetaFileIn(folder), '');
      const kept = new Set((await listDir(folder)).map((d) => d.name).filter(keep));
      for (const entry of await listDir(folder)) {
        if (!kept.has(entry.name)) await remove(fileInFolder(folder, entry.name));
      }
      for (const entry of await listDir(staged)) {
        if (!kept.has(entry.name)) await rename(fileInFolder(staged, entry.name), fileInFolder(folder, entry.name));
      }
      await write(modMetaFileIn(folder), setOwnedKeysInText(carried, keysOver(keys, parseMetaIni(carried))));
    },
  };
}

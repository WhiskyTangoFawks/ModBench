// How MO2's implementation lands a mod: staged beside the mod folders, then one rename into place,
// or an upgrade that replaces a folder's contents in place.

import { parseMetaIni, setOwnedKeysInText, writeMetaIni } from './codecs/metaIni';
import { ensureDir, get, listDir, makeTempDir, remove, rename, write } from './files';
import type { InstanceAdapter, ModMeta, OwnedMetaKeys } from './instanceAdapter';
import { fileInFolder, modMetaFileIn, modsDir, stagingPrefix } from './layout';
import { folderHolding, newModFolder, type Mo2Context } from './mo2Context';

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
      const folder = newModFolder(context, mod);
      await write(modMetaFileIn(staged), writeMetaIni(keys));
      await ensureDir(modsDir(instanceRoot));
      await rename(staged, folder);
    },

    // The meta the mod had is read before its contents go, so its own keys survive the release. A
    // release holding an entry the folder keeps is refused before anything is removed.
    async upgradeMod(mod, staged, keys, keep) {
      const folder = (await folderHolding(context, { kind: 'mod', name: mod }))?.path;
      if (folder === undefined) throw new Error(`No folder holds the mod "${mod}"`);
      const entries = (await listDir(folder)).map((d) => d.name);
      const kept = new Set(entries.filter(keep));
      const released = (await listDir(staged)).map((d) => d.name);
      const clash = released.find((name) => kept.has(name));
      if (clash !== undefined) throw new Error(`The release holds "${clash}", which the upgrade keeps from "${mod}"`);
      const carried = await get(modMetaFileIn(folder), '');
      for (const name of entries) {
        if (!kept.has(name)) await remove(fileInFolder(folder, name));
      }
      for (const name of released) await rename(fileInFolder(staged, name), fileInFolder(folder, name));
      await write(modMetaFileIn(folder), setOwnedKeysInText(carried, keysOver(keys, parseMetaIni(carried))));
    },
  };
}

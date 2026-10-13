// What MO2 records of a mod's installation: the downloaded file meta.ini names, and meta.ini itself.

import { MOD_META_FILE_NAME, parseMetaIni } from './codecs/metaIni';
import { get } from './files';
import type { InstanceAdapter } from './instanceAdapter';
import { modMetaFile } from './layout';
import { readOrAbsent, type Mo2Context } from './mo2Context';

export function mo2Installation({ instanceRoot }: Mo2Context): Pick<InstanceAdapter, 'installationFiles' | 'managerFilesInModFolder'> {
  return {
    async installationFiles(mod) {
      const { archiveFilename } = await readOrAbsent(async () => parseMetaIni(await get(modMetaFile(instanceRoot, mod))), {});
      return archiveFilename === undefined
        ? { kind: 'read', answer: [] }
        : { kind: 'unreadable', reason: `Modbench cannot yet tell what ${archiveFilename} installs: the downloaded files' index is not built.` };
    },

    managerFilesInModFolder: [MOD_META_FILE_NAME],
  };
}

// What MO2 records of a mod's installation: the downloaded file meta.ini names, and meta.ini itself.

import { basename, isAbsolute } from 'node:path';
import { MOD_META_FILE_NAME, parseMetaIni } from './codecs/metaIni';
import { exists, get, readOrReason } from './files';
import type { FileRead, InstallationFile, InstanceAdapter } from './instanceAdapter';
import { downloadFile, modMetaFile } from './layout';
import { currentDownloadsDir, readOrAbsent, type Mo2Context } from './mo2Context';

// MO2 records a file installed from outside the downloads folder by its whole path, and reinstalls from the
// downloads folder by its name once that path is gone.
async function reinstallPath(context: Mo2Context, recorded: string): Promise<string> {
  return isAbsolute(recorded) && (await exists(recorded)) ? recorded : downloadFile(await currentDownloadsDir(context), basename(recorded));
}

export function mo2Installation(
  context: Mo2Context, { downloadedFileHash }: Pick<InstanceAdapter, 'downloadedFileHash'>,
): Pick<InstanceAdapter, 'installationFiles' | 'managerFilesInModFolder'> {
  return {
    async installationFiles(mod) {
      const { archiveFilename } = await readOrAbsent(async () => parseMetaIni(await get(modMetaFile(context.instanceRoot, mod))), {});
      if (archiveFilename === undefined) return { kind: 'read', answer: [] };
      const refused = (why: string): FileRead<readonly InstallationFile[]> =>
        ({ kind: 'unreadable', reason: `Modbench cannot tell what ${archiveFilename} installs: ${why}` });
      const located = await readOrReason(() => reinstallPath(context, archiveFilename));
      if (located.kind === 'unreadable') return refused(located.reason);
      const path = located.answer;
      const hashed = await downloadedFileHash(path);
      return hashed.kind === 'read' ? { kind: 'read', answer: [{ path, ...hashed.answer }] } : refused(hashed.reason);
    },

    managerFilesInModFolder: [MOD_META_FILE_NAME],
  };
}

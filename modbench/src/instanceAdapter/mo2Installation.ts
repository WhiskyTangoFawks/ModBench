// What MO2 records of a mod's installation: the downloaded file meta.ini names, and meta.ini itself.

import { basename, isAbsolute } from 'node:path';
import { gamePathInfoForRelease, gameReleaseForMetaGame } from '../tables/gamePaths';
import { MOD_META_FILE_NAME } from './codecs/metaIni';
import { readGameName } from './codecs/modOrganizerIni';
import { exists, get, readOrReason } from './files';
import type { HashIndex } from './hashIndex';
import type { FileRead, InstallationFile, InstanceAdapter, ModMeta } from './instanceAdapter';
import { downloadFile, settingsFile } from './layout';
import { currentDownloadsDir, type Mo2Context } from './mo2Context';
import type { ReadingSource } from './mo2Reads';
import { formatNexusSource } from './nexusSource';

// MO2 records a file installed from outside the downloads folder by its whole path, and reinstalls from the
// downloads folder by its name once that path is gone.
async function reinstallPath(context: Mo2Context, recorded: string): Promise<string> {
  return isAbsolute(recorded) && (await exists(recorded)) ? recorded : downloadFile(await currentDownloadsDir(context), basename(recorded));
}

// A mod with no game of its own is the instance's game's.
async function nexusSourceOf(
  { gameName, nexusId, installedFiles = [] }: ModMeta, { instanceRoot }: Mo2Context,
): Promise<Pick<InstallationFile, 'source' | 'unsourcedGame'>> {
  if (nexusId === undefined && installedFiles.length === 0) return {};
  const game = gameName ?? readGameName(await get(settingsFile(instanceRoot)));
  const release = gameReleaseForMetaGame(game);
  const domain = release === undefined ? undefined : gamePathInfoForRelease(release)?.nexusSlug;
  return domain === undefined ? { unsourcedGame: game } : { source: formatNexusSource({ game: domain, modId: nexusId, files: installedFiles }) };
}

export function mo2Installation(
  context: Mo2Context, { downloadedFileHash }: Pick<HashIndex, 'downloadedFileHash'>, { modMeta }: Pick<ReadingSource, 'modMeta'>,
): Pick<InstanceAdapter, 'installationFiles' | 'downloadedFile' | 'modVersion' | 'managerFilesInModFolder'> {
  return {
    async modVersion(mod) {
      return (await modMeta(mod)).version;
    },

    async installationFiles(mod) {
      const meta = await modMeta(mod);
      const { archiveFilename } = meta;
      if (archiveFilename === undefined) return { kind: 'read', answer: [] };
      const refused = (why: string): FileRead<readonly InstallationFile[]> =>
        ({ kind: 'unreadable', reason: `Modbench cannot tell what ${archiveFilename} installs: ${why}` });
      const located = await readOrReason(() => reinstallPath(context, archiveFilename));
      if (located.kind === 'unreadable') return refused(located.reason);
      const path = located.answer;
      const hashed = await downloadedFileHash(path);
      return hashed.kind === 'read' ? { kind: 'read', answer: [{ path, ...(await nexusSourceOf(meta, context)), ...hashed.answer }] } : refused(hashed.reason);
    },

    async downloadedFile(name) {
      const located = await readOrReason(async () => downloadFile(await currentDownloadsDir(context), name));
      if (located.kind === 'unreadable') return located;
      const path = located.answer;
      if (!(await exists(path))) return { kind: 'read', answer: undefined };
      const hashed = await downloadedFileHash(path);
      return hashed.kind === 'read' ? { kind: 'read', answer: { path, ...hashed.answer } } : hashed;
    },

    managerFilesInModFolder: [MOD_META_FILE_NAME],
  };
}

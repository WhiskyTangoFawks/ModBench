// What MO2 records of a mod's installation: the downloaded file meta.ini names, and meta.ini itself.

import { basename, isAbsolute } from 'node:path';
import { gamePathInfoForRelease, gameReleaseForMetaGame, gameReleaseForNexusDomain } from '../tables/gamePaths';
import { MOD_META_FILE_NAME, parseMetaIni, setOwnedKeysInText } from './codecs/metaIni';
import { readGameName } from './codecs/modOrganizerIni';
import { ensureDir, exists, get, readOrReason, withLock, write } from './files';
import type { HashIndex } from './hashIndex';
import type { FileRead, InstallationFile, InstanceAdapter, ModMeta, OwnedMetaKeys } from './instanceAdapter';
import { downloadFile, modMetaFileIn, settingsFile } from './layout';
import { currentDownloadsDir, folderHolding, newModFolder, type Mo2Context } from './mo2Context';
import type { ReadingSource } from './mo2Reads';
import { formatNexusSource, parseNexusSource } from './nexusSource';

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

// The instance's own spelling when its game has the domain, else the manager's short name for the first game that does.
async function metaGameOf(domain: string, { instanceRoot }: Mo2Context): Promise<string> {
  const release = gameReleaseForNexusDomain(domain);
  if (release === undefined) throw new Error(`its source names the Nexus game '${domain}', which Modbench has no game for`);
  const instanceGame = readGameName(await get(settingsFile(instanceRoot)));
  const own = gameReleaseForMetaGame(instanceGame);
  return own !== undefined && gamePathInfoForRelease(own)?.nexusSlug === domain ? instanceGame : release;
}

// A source the manager cannot spell leaves the carried keys as they are.
async function nexusKeysOver(
  carried: ModMeta, source: string | undefined, context: Mo2Context,
): Promise<Partial<OwnedMetaKeys>> {
  const nexus = source === undefined ? undefined : parseNexusSource(source);
  if (nexus === undefined) return { gameName: carried.gameName, nexusId: carried.nexusId, installedFiles: carried.installedFiles };
  return { gameName: await metaGameOf(nexus.game, context), nexusId: nexus.modId, installedFiles: nexus.files };
}

export function mo2Installation(
  context: Mo2Context, { downloadedFileHash }: Pick<HashIndex, 'downloadedFileHash'>, { modMeta }: Pick<ReadingSource, 'modMeta'>,
): Pick<InstanceAdapter, 'installationFiles' | 'downloadedFile' | 'modVersion' | 'modMetadata' | 'writeModMetadata' | 'managerFilesInModFolder'> {
  return {
    async modVersion(mod) {
      return (await modMeta(mod)).version;
    },

    async modMetadata(mod) {
      const meta = await modMeta(mod);
      const { archiveFilename } = meta;
      const { source } = await nexusSourceOf(meta, context);
      return { version: meta.version, installationFiles: archiveFilename === undefined ? [] : [{ name: basename(archiveFilename), source }] };
    },

    writeModMetadata: (mod, { version, installationFiles: [first] }) => withLock(context.instanceRoot, async () => {
      if (version === undefined && first === undefined) return;
      const folder = (await folderHolding(context, { kind: 'mod', name: mod }))?.path ?? newModFolder(context, mod);
      const file = modMetaFileIn(folder);
      const held = await get(file, '');
      const carried = parseMetaIni(held);
      const nexusKeys = await nexusKeysOver(carried, first?.source, context);
      await ensureDir(folder);
      await write(file, setOwnedKeysInText(held, {
        ...nexusKeys, version: version ?? carried.version, archiveFilename: first?.name ?? carried.archiveFilename,
      }));
    }),

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
      // A manifest is text from the repository: a name with a folder in it would reach outside the downloads folder.
      if (basename(name) !== name || name === '..') return { kind: 'read', answer: undefined };
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

// What MO2 records of a mod's installation: the downloaded file meta.ini names, and meta.ini itself.

import { entryNamed } from './codecs/modlistText';
import { basename, dirname, isAbsolute } from 'node:path';
import { gameReleaseForNexusDomain, nexusDomainForMetaGame } from '../../tables/gamePaths';
import { changeOwnedKeysInText, type InstalledFileId, type MetaIni, metaIniOf, modMetaOf, MOD_META_FILE_NAME, type OwnedMetaKeys, parseMetaIni } from './codecs/metaIni';
import { readGameName } from './codecs/modOrganizerIni';
import { ensureDir, exists, get, readOrReason, withLock, write } from '../files';
import type { HashIndex } from '../downloadedFileContents/hashIndex';
import { md5Of } from '../downloadedFileContents/contentDigest';
import type { FileRead, InstallationFile, InstanceAdapter, ModMetadata, NexusModFile } from '../instanceAdapter';
import { downloadedFileMetadataPath, downloadedFilePath, modMetaFileIn, settingsFile } from './layout';
import { parseDownloadedFileMeta } from './codecs/downloads';
import { effectiveModId } from './codecs/nexusFileName';
import { currentDownloadsDir, folderHolding, newModFolder, nexusDomainsOfInstance, type Mo2Context } from './mo2Context';
import { readMetaIni } from './mo2Reads';
import { formatNexusPage, parseNexusPage } from '../nexusPage';

// MO2 records a file installed from outside the downloads folder by its whole path, and reinstalls from the
// downloads folder by its name once that path is gone.
async function reinstallPath(context: Mo2Context, recorded: string): Promise<string> {
  return isAbsolute(recorded) && (await exists(recorded)) ? recorded : downloadedFilePath(await currentDownloadsDir(context), basename(recorded));
}

// The file a mod's metadata names: the first installed from its Nexus mod, else the first.
const installedFileOf = ({ nexusId, installedFiles = [] }: MetaIni): InstalledFileId | undefined =>
  installedFiles.find((file) => file.nexusId === nexusId) ?? installedFiles[0];

// A mod with no game of its own is the instance's game's.
async function nexusPageOf(meta: MetaIni, { instanceRoot }: Mo2Context): Promise<Pick<InstallationFile, 'page' | 'unpagedGame'>> {
  const file = installedFileOf(meta);
  const modId = file?.nexusId || meta.nexusId;
  if (!modId) return {};
  const game = meta.gameName ?? readGameName(await get(settingsFile(instanceRoot)));
  const domain = nexusDomainForMetaGame(game);
  return domain === undefined ? { unpagedGame: game } : { page: formatNexusPage({ game: domain, modId, fileId: file?.fileId }) };
}

// The page of a downloaded file on its host, from its metadata, else its name.
async function pageOfDownloadedFile(context: Mo2Context, downloadsDir: string, name: string): Promise<string | undefined> {
  const { meta } = parseDownloadedFileMeta(await get(downloadedFileMetadataPath(downloadsDir, name), ''));
  const modId = effectiveModId(meta.modID, name);
  if (modId === undefined) return undefined;
  const domain = nexusDomainForMetaGame(meta.gameName ?? readGameName(await get(settingsFile(context.instanceRoot))));
  return domain === undefined ? undefined : formatNexusPage({ game: domain, modId, fileId: meta.fileID });
}

async function metaGameFor(domain: string, { instanceRoot }: Mo2Context): Promise<string | undefined> {
  const instanceGame = readGameName(await get(settingsFile(instanceRoot)));
  return nexusDomainForMetaGame(instanceGame) === domain ? instanceGame : gameReleaseForNexusDomain(domain);
}

type MetadataPlan = { readonly unwritable: string } | { readonly file: string; readonly held: string; readonly changes: Partial<OwnedMetaKeys> };

async function pageChanges(carried: MetaIni, page: string, context: Mo2Context): Promise<Partial<OwnedMetaKeys> | { readonly unwritable: string }> {
  const nexus = parseNexusPage(page);
  if (nexus === undefined) return { unwritable: `its page '${page}' is not a Nexus page, the only host MO2's metadata holds` };
  const gameName = await metaGameFor(nexus.game, context);
  if (gameName === undefined) return { unwritable: `its page names the Nexus game '${nexus.game}', which Modbench has no game for` };
  const carriedFile = installedFileOf(carried);
  const sameFile = nexus.fileId === undefined ? carriedFile === undefined : carriedFile?.fileId === nexus.fileId && carriedFile.nexusId === nexus.modId;
  const installedFiles = sameFile ? carried.installedFiles : nexus.fileId === undefined ? undefined : [{ nexusId: nexus.modId, fileId: nexus.fileId }];
  const answered = (await nexusPageOf({ ...carried, installedFiles }, context)).page;
  const agrees = answered === formatNexusPage(nexus);
  const heldGame = carried.gameName ?? readGameName(await get(settingsFile(context.instanceRoot)));
  return {
    ...(nexusDomainForMetaGame(heldGame) === nexus.game ? {} : { gameName }),
    ...((agrees && sameFile) || nexus.modId === carried.nexusId ? {} : { nexusId: nexus.modId }),
    ...(sameFile ? {} : { installedFiles }),
  };
}

async function metaFileOf(context: Mo2Context, mod: string): Promise<string> {
  return modMetaFileIn((await folderHolding(context, { kind: 'mod', name: mod }))?.path ?? newModFolder(context, mod));
}

// MO2 holds one installation file: the one it holds if the manifest names it, else the manifest's first.
async function planMetadata(context: Mo2Context, mod: string, { version, installationFile: chosen }: ModMetadata): Promise<MetadataPlan> {
  const file = await metaFileOf(context, mod);
  if (entryNamed(mod).kind === 'separator') return { file, held: '', changes: {} };
  const held = await get(file, '');
  const carried = parseMetaIni(held);
  const heldName = carried.installationFileName === undefined ? undefined : basename(carried.installationFileName);
  const changes: Partial<OwnedMetaKeys> = version === undefined || version === carried.version ? {} : { version };
  if (chosen === undefined) return { file, held, changes };
  if (chosen.name !== heldName) Object.assign(changes, { installationFileName: chosen.name });
  if (chosen.page !== undefined) {
    const fromPage = await pageChanges(carried, chosen.page, context);
    if ('unwritable' in fromPage) return fromPage;
    Object.assign(changes, fromPage);
  } else if (chosen.name !== heldName) {
    Object.assign(changes, {
      ...(carried.nexusId === undefined ? {} : { nexusId: undefined }),
      ...((carried.installedFiles ?? []).length === 0 ? {} : { installedFiles: undefined }),
    });
  }
  return { file, held, changes };
}

async function metadataOf(meta: MetaIni, context: Mo2Context): Promise<ModMetadata> {
  const { installationFileName } = meta;
  const { page } = await nexusPageOf(meta, context);
  return { version: meta.version, installationFile: installationFileName === undefined ? undefined : { name: basename(installationFileName), page } };
}

async function nexusFileOf(meta: MetaIni, context: Mo2Context): Promise<NexusModFile | undefined> {
  const { page, unpagedGame } = await nexusPageOf(meta, context);
  if (unpagedGame !== undefined) throw new Error(`Nexus has no game for '${unpagedGame}'`);
  const nexus = page === undefined ? undefined : parseNexusPage(page);
  return nexus === undefined ? undefined : { game: nexus.game, modId: nexus.modId, fileId: nexus.fileId, fileName: meta.installationFileName === undefined ? undefined : basename(meta.installationFileName), fileStatus: meta.nexusFileStatus };
}

export function mo2Installation(
  context: Mo2Context, { downloadedFileHash, indexedDownloadedFiles }: Pick<HashIndex, 'downloadedFileHash' | 'indexedDownloadedFiles'>,
): Pick<InstanceAdapter, 'installationFile' | 'downloadedFile' | 'indexedDownloadedFiles' | 'nexusFileAt' | 'downloadedFileQuery' | 'modMetadata' | 'nexusFile' | 'writeNewestVersion' | 'metadataOf' | 'unwritableMetadata' | 'writeModMetadata' | 'metadataFilesInModFolder'> {
  return {
    modMetadata: (mod) => readOrReason(async () => metadataOf(await readMetaIni(context, mod, 'list'), context)),

    nexusFile: (mod) => readOrReason(async () => nexusFileOf(await readMetaIni(context, mod, 'list'), context)),

    writeNewestVersion: (mod, version) => withLock(context.instanceRoot, async () => {
      const file = await metaFileOf(context, mod);
      const held = await get(file, '');
      const carried = parseMetaIni(held);
      if (carried.newestVersion !== version) await write(file, changeOwnedKeysInText(held, { newestVersion: version }));
      return { updateAvailable: modMetaOf({ ...carried, newestVersion: version }).updateAvailable === true };
    }),

    metadataOf: (meta) => metadataOf(metaIniOf(meta), context),

    unwritableMetadata: async (mod, metadata) => {
      const plan = await planMetadata(context, mod, metadata);
      return 'unwritable' in plan ? plan.unwritable : undefined;
    },

    writeModMetadata: (mod, metadata) => withLock(context.instanceRoot, async () => {
      const plan = await planMetadata(context, mod, metadata);
      if ('unwritable' in plan) throw new Error(`the metadata changed after it was found writable: ${plan.unwritable}`);
      if (Reflect.ownKeys(plan.changes).length === 0) return;
      await ensureDir(dirname(plan.file));
      await write(plan.file, changeOwnedKeysInText(plan.held, plan.changes));
    }),

    async installationFile(mod) {
      const meta = await readMetaIni(context, mod, 'list');
      const { installationFileName } = meta;
      if (installationFileName === undefined) return { kind: 'read', answer: undefined };
      const refused = (why: string): FileRead<InstallationFile | undefined> =>
        ({ kind: 'unreadable', reason: `Modbench cannot tell what ${installationFileName} installs: ${why}` });
      const located = await readOrReason(() => reinstallPath(context, installationFileName));
      if (located.kind === 'unreadable') return refused(located.reason);
      const path = located.answer;
      const hashed = await downloadedFileHash(path);
      return hashed.kind === 'read' ? { kind: 'read', answer: { path, ...(await nexusPageOf(meta, context)), ...hashed.answer } } : refused(hashed.reason);
    },

    async downloadedFile(name) {
      // A manifest is text from the repository: a name with a folder in it would reach outside the downloads folder.
      if (basename(name) !== name || name === '..') return { kind: 'read', answer: undefined };
      const located = await readOrReason(async () => downloadedFilePath(await currentDownloadsDir(context), name));
      if (located.kind === 'unreadable') return located;
      const path = located.answer;
      if (!(await exists(path))) return { kind: 'read', answer: undefined };
      const hashed = await downloadedFileHash(path);
      return hashed.kind === 'read' ? { kind: 'read', answer: { path, ...hashed.answer } } : hashed;
    },

    indexedDownloadedFiles: () => readOrReason(async () => {
      const downloadsDir = await currentDownloadsDir(context);
      const indexed = (await indexedDownloadedFiles()).filter(({ path }) => dirname(path) === downloadsDir);
      return Promise.all(indexed.map(async (file) => ({ ...file, page: await pageOfDownloadedFile(context, downloadsDir, basename(file.path)) })));
    }),

    nexusFileAt: parseNexusPage,

    downloadedFileQuery: (name) => readOrReason(async () => {
      if (basename(name) !== name || name === '..') return undefined;
      const downloadsDir = await currentDownloadsDir(context);
      const path = downloadedFilePath(downloadsDir, name);
      if (!(await exists(path))) return undefined;
      const { meta } = parseDownloadedFileMeta(await get(downloadedFileMetadataPath(downloadsDir, name), ''));
      return { games: await nexusDomainsOfInstance(context), md5: await md5Of(path), modID: effectiveModId(meta.modID, name), fileID: meta.fileID };
    }),

    metadataFilesInModFolder: [MOD_META_FILE_NAME],
  };
}

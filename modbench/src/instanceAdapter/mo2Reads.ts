// MO2's parsed reads: each file read through its own codec, and each answer about where the
// instance keeps what.

import { basename, dirname } from 'node:path';
import { parsePlugins } from '../loadOrderFileCodec/pluginsText';
import { errorMessage } from '../ports/errorMessage';
import { DOWNLOAD_SIDECAR_SUFFIX, parseDownloadMeta } from './codecs/downloads';
import { parseMetaIni } from './codecs/metaIni';
import { parseModlist } from './codecs/modlistText';
import { readGameName, readSelectedProfile } from './codecs/modOrganizerIni';
import { creationClubListFile, dataFolderOf, gameReleaseForGame } from '../tables/gamePaths';
import { digestOf } from './contentDigest';
import { factsOf, get, listDir, stampOf } from './files';
import {
  type DataFolderPlugins, type InstanceReading, type ModFolders, type ModMeta, type ModlistEntry, type DownloadedFile, type DownloadedFiles, type FileRead, type GameFolder, type InstanceAdapter,
} from './instanceAdapter';
import {
  DATA_FOLDER_PLUGINS_GLOB, DOWNLOADS_WATCH_GLOB, downloadFile, entryDir, downloadNameAt, downloadSidecarFile, isTempWrite, modlistFile,
  modMetaFile, modSourceDir, pluginsFile, profilesDir, settingsFile,
} from './layout';
import { folderHolding, listedAs, listModFolders, modFoldersOf, readOrAbsent, type Mo2Context } from './mo2Context';
import { originFilesIn } from './mo2Files';
import { sourceModsIn } from './sourceMods';
import { isPluginFile } from './pluginFile';

type Mo2Reads = Omit<InstanceAdapter,
  | 'changeModOrder' | 'changePluginOrder' | 'createModFolder' | 'renameModFolder' | 'trashEntryFolder' | 'trashSourceFolder' | 'markDownloadedFile'
  | 'trashDownloadedFileMeta' | 'selectProfile' | 'markOriginFile' | 'includedPath' | 'excludedSuffix' | 'renamePlugin' | 'extractedEntries'
  | 'extractNewMod' | 'extractUpgrade' | 'subscribe' | 'names' | 'archiveList' | 'gameFolderArchives' | 'installationFiles'
  | 'managerFilesInModFolder' | 'reading'>;

async function listDownloadedFiles(downloadsDir: string): Promise<DownloadedFile[] | undefined> {
  const dirents = await readOrAbsent(() => listDir(downloadsDir), undefined);
  if (dirents === undefined) return undefined;
  const names = dirents
    .filter((d) => d.isFile() && !isTempWrite(d.name) && !d.name.endsWith(DOWNLOAD_SIDECAR_SUFFIX))
    .map((d) => d.name);
  return Promise.all(names.map(async (name) => {
    const path = downloadFile(downloadsDir, name);
    const metaPath = downloadSidecarFile(downloadsDir, name);
    const [facts, metaText] = await Promise.all([
      factsOf(path),
      readOrAbsent<string | undefined>(() => get(metaPath), undefined),
    ]);
    const meta = metaText === undefined ? undefined : parseDownloadMeta(metaText);
    return { name, path, metaPath, size: facts.size, mtimeMs: facts.mtimeMs, meta };
  }));
}

async function listGameFolderPlugins(gameFolder: GameFolder): Promise<DataFolderPlugins> {
  const dataFolder = dataFolderOf(gameFolder);
  if (dataFolder === undefined) return { kind: 'unresolved' };
  try {
    const dirents = await listDir(dataFolder);
    return { kind: 'listed', names: new Set(dirents.filter((d) => d.isFile() && isPluginFile(d.name)).map((d) => d.name)) };
  } catch (err) {
    return { kind: 'unreadable', reason: errorMessage(err) };
  }
}

// The game writes its Creation Club list in plugins.txt's own line format.
async function readCreationClubList(gameFolder: GameFolder, gameRelease: string | undefined): Promise<string[]> {
  const file = gameFolder.kind === 'found' ? creationClubListFile(gameFolder.root, gameRelease) : undefined;
  if (file === undefined) return [];
  const text = await readOrAbsent<string | undefined>(() => get(file), undefined);
  return text === undefined ? [] : parsePlugins(text).map((entry) => entry.name);
}

async function answerOrReason<T>(read: () => Promise<T>): Promise<FileRead<T>> {
  try {
    return { kind: 'read', answer: await read() };
  } catch (err) {
    return { kind: 'unreadable', reason: errorMessage(err) };
  }
}

// The tables key each release on the game's name as `gameName=` spells it.
const gameOf = (gameName: string) => ({ gameName, gameRelease: gameReleaseForGame(gameName) });

export function mo2Reads(context: Mo2Context): Mo2Reads {
  const { instanceRoot, resolveGameFolder, resolveDownloadsFolder, watch } = context;
  return {
    async settings() {
      const iniText = await get(settingsFile(instanceRoot));
      const game = gameOf(readGameName(iniText));
      return {
        profile: readSelectedProfile(iniText),
        ...game,
        // What the settings resolve is what the watch follows.
        gameFolder: async () => {
          const gameFolder = await resolveGameFolder(iniText);
          watch.follow('gameFolderPlugins', dataFolderOf(gameFolder), DATA_FOLDER_PLUGINS_GLOB);
          const creationClubList = gameFolder.kind === 'found'
            ? creationClubListFile(gameFolder.root, game.gameRelease)
            : undefined;
          if (creationClubList === undefined) watch.follow('creationClubList', undefined, '');
          else watch.follow('creationClubList', dirname(creationClubList), basename(creationClubList));
          return gameFolder;
        },
        downloadedFiles: async (): Promise<DownloadedFiles> => {
          const resolution = await resolveDownloadsFolder(instanceRoot, iniText);
          watch.follow('downloadedFiles', resolution.kind === 'resolved' ? resolution.downloadsDir : undefined, DOWNLOADS_WATCH_GLOB);
          if (resolution.kind === 'unresolved') return resolution;
          const { downloadsDir } = resolution;
          return { kind: 'listed', downloadsDir, files: await listDownloadedFiles(downloadsDir) };
        },
      };
    },

    async profiles() {
      const dirents = await readOrAbsent(() => listDir(profilesDir(instanceRoot)), []);
      return dirents.filter((d) => d.isDirectory()).map((d) => d.name);
    },

    async modOrder(profile) {
      return parseModlist(await get(modlistFile(instanceRoot, profile)));
    },

    async orderEntry(profile, entry) {
      return listedAs(parseModlist(await get(modlistFile(instanceRoot, profile))), entry);
    },

    modMeta(mod) {
      return readOrAbsent(async () => parseMetaIni(await get(modMetaFile(instanceRoot, mod))), {});
    },

    modFolders: async (skippedLink) => {
      const all = await listModFolders(context, skippedLink);
      return all === undefined ? undefined : modFoldersOf(all);
    },

    async pluginOrder(profile) {
      return parsePlugins(await get(pluginsFile(instanceRoot, profile)));
    },

    gameFolderPlugins: listGameFolderPlugins,

    creationClubList: readCreationClubList,

    async downloadedFileAt(path) {
      const resolution = await resolveDownloadsFolder(instanceRoot, await get(settingsFile(instanceRoot)));
      return resolution.kind === 'resolved' ? downloadNameAt(resolution.downloadsDir, path, process.platform) : undefined;
    },

    entryFolder: (entry) => folderHolding(context, entry),
    modFolderPath: async (name) => (await folderHolding(context, { kind: 'mod', name }))?.path ?? entryDir(instanceRoot, { kind: 'mod', name }),

    originFiles: (origin) => originFilesIn(instanceRoot, origin),

    sourceFolder: (mod) => modSourceDir(instanceRoot, mod),

    sourceMods: () => sourceModsIn(instanceRoot),

    fileStamp: (path) => answerOrReason(() => stampOf(path)),

    contentDigest: (path) => answerOrReason(() => digestOf(path)),
  };
}

type ReadingSource = Pick<InstanceAdapter,
  | 'settings' | 'modOrder' | 'modMeta' | 'pluginOrder' | 'gameFolderPlugins' | 'creationClubList' | 'archiveList'
  | 'gameFolderArchives' | 'profiles' | 'modFolders' | 'originFiles' | 'sourceMods'>;

// How long another tool's write takes to settle before an empty mod order is believed.
const SETTLE_MS = 200;

const modsWithMeta = async (source: ReadingSource, profile: string): Promise<ModlistEntry[]> =>
  Promise.all((await source.modOrder(profile)).map(async (entry) =>
    (entry.kind === 'mod' ? { ...entry, ...(await source.modMeta(entry.name)) } : entry)));

async function settledMods(source: ReadingSource, profile: string): Promise<ModlistEntry[]> {
  const mods = await modsWithMeta(source, profile);
  if (mods.length > 0) return mods;
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  return modsWithMeta(source, profile);
}

const metaOf = ({ version, nexusId, archiveFilename, installedFiles }: ModMeta): ModMeta =>
  ({ version, nexusId, archiveFilename, installedFiles });

// A listed mod's meta is the one already read. A folder the mod order does not list is read only
// when downloaded files are there to be matched against it.
async function folderMetaOf(
  source: ReadingSource, entries: readonly ModlistEntry[], folders: ModFolders | undefined, downloadsListed: boolean,
): Promise<ReadonlyMap<string, ModMeta>> {
  const read = new Map(entries.flatMap((entry) => (entry.kind === 'mod' ? [[entry.name, metaOf(entry)] as const] : [])));
  const unlisted = downloadsListed
    ? (folders?.all ?? []).filter((folder) => folder.kind === 'mod' && !read.has(folder.name))
    : [];
  const unlistedMetas = await Promise.all(unlisted.map(async ({ name }) => [name, await source.modMeta(name)] as const));
  return new Map([...read, ...unlistedMetas]);
}

/** The instance whole, every fact against the one read of the settings, so a profile switch
 *  mid-read cannot mix one profile's mod order with another's plugin order. */
export async function readInstance(source: ReadingSource): Promise<InstanceReading> {
  const settings = await source.settings();
  const { profile, gameName, gameRelease } = settings;
  const skippedLinks = new Map<string, string>();
  const modsRead = settledMods(source, profile);
  const modFoldersRead = source.modFolders((name, reason) => skippedLinks.set(name, reason));
  const sourceModsRead = source.sourceMods();
  const downloadsRead = settings.downloadedFiles();
  const [mods, pluginOrder, downloadedFiles, game, profiles, modFolders, runtimeOutput, sourceMods, modFiles, folderMeta] = await Promise.all([
    modsRead,
    source.pluginOrder(profile),
    downloadsRead,
    settings.gameFolder().then(async (gameFolder) => ({
      gameFolder,
      dataFolderPlugins: await source.gameFolderPlugins(gameFolder),
      creationClubList: await source.creationClubList(gameFolder, gameRelease),
      archiveList: await source.archiveList(profile, gameFolder, gameRelease),
      dataFolderArchives: await source.gameFolderArchives(gameFolder, gameRelease),
    })),
    source.profiles(),
    modFoldersRead,
    source.originFiles({ kind: 'runtimeOutput' }),
    sourceModsRead,
    modsRead.then(async (entries) => new Map(await Promise.all(entries.filter((entry) => entry.kind === 'mod')
      .map(async ({ name }) => [name, await source.originFiles({ kind: 'mod', name })] as const)))),
    Promise.all([modsRead, modFoldersRead, downloadsRead]).then(([entries, folders, downloads]) =>
      folderMetaOf(source, entries, folders, downloads.kind === 'listed' && downloads.files !== undefined)),
  ]);
  const { archiveList, dataFolderArchives, ...gameFacts } = game;
  return {
    profile, gameName, gameRelease, mods, pluginOrder, downloadedFiles, ...gameFacts,
    archiveList: archiveList.archives, archiveListNotes: archiveList.notes, dataFolderArchives,
    profiles, modFolders, skippedLinks, runtimeOutput, modFiles, folderMeta,
    sourceMods,
  };
}

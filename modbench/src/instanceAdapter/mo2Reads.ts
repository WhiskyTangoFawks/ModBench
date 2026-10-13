// MO2's parsed reads: each file read through its own codec, and each answer about where the
// instance keeps what.

import { basename, dirname, join } from 'node:path';
import { parsePlugins } from '../loadOrderFileCodec/pluginsText';
import { errorMessage } from '../ports/errorMessage';
import { DOWNLOAD_SIDECAR_SUFFIX, parseDownloadMeta } from './codecs/downloads';
import { parseMetaIni } from './codecs/metaIni';
import { parseModlist } from './codecs/modlistText';
import { readGameName, readSelectedProfile } from './codecs/modOrganizerIni';
import { creationClubListFile, dataFolderOf, gameReleaseForGame } from '../tables/gamePaths';
import { digestOf } from './contentDigest';
import { factsOf, get, isTracked, listDir, listFolders, stampOf } from './files';
import {
  type DataFolderPlugins, type InstanceReading, type ModlistEntry, type DownloadedFile, type DownloadedFiles, type FileRead, type GameFolder, type InstanceAdapter,
} from './instanceAdapter';
import {
  DATA_FOLDER_PLUGINS_GLOB, DOWNLOADS_WATCH_GLOB, downloadFile, downloadNameAt, downloadSidecarFile, isTempWrite, modlistFile,
  modMetaFile, modSourceDir, pluginsFile, profilesDir, settingsFile, sourceRootDir,
} from './layout';
import { folderHolding, listedAs, listModFolders, modFoldersOf, readOrAbsent, type Mo2Context } from './mo2Context';
import { originFilesIn } from './mo2Files';
import { isPluginFile } from './pluginFile';

type Mo2Reads = Omit<InstanceAdapter,
  | 'changeModOrder' | 'changePluginOrder' | 'createModFolder' | 'renameModFolder' | 'trashEntryFolder' | 'trashSourceFolder' | 'markDownloadedFile'
  | 'trashDownloadedFileMeta' | 'selectProfile' | 'markOriginFile' | 'renamePlugin' | 'extractedEntries'
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

const sourceTracked = (folder: string | undefined): Promise<boolean> =>
  (folder === undefined ? Promise.resolve(false) : isTracked(folder));

async function sourceRepositories(instanceRoot: string): Promise<string[]> {
  const folders = await readOrAbsent(() => listFolders(sourceRootDir(instanceRoot)), []);
  const held = await Promise.all(folders.map(async (name) => ((await isTracked(join(sourceRootDir(instanceRoot), name))) ? [name] : [])));
  return held.flat();
}

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

    originFiles: (origin) => originFilesIn(instanceRoot, origin),

    sourceFolder: (mod) => modSourceDir(instanceRoot, mod),

    modTracked: (mod) => sourceTracked(modSourceDir(instanceRoot, mod)),

    sourceMods: () => sourceRepositories(instanceRoot),

    fileStamp: (path) => answerOrReason(() => stampOf(path)),

    contentDigest: (path) => answerOrReason(() => digestOf(path)),
  };
}

type ReadingSource = Pick<InstanceAdapter,
  | 'settings' | 'modOrder' | 'modMeta' | 'pluginOrder' | 'gameFolderPlugins' | 'creationClubList' | 'archiveList'
  | 'gameFolderArchives' | 'profiles' | 'modFolders' | 'originFiles' | 'modTracked' | 'sourceMods' | 'sourceFolder'>;

// How long another tool's write takes to settle before an empty mod order is believed.
const SETTLE_MS = 200;

const modsWithMeta = async (source: ReadingSource, profile: string): Promise<ModlistEntry[]> =>
  Promise.all((await source.modOrder(profile)).map(async (entry) =>
    (entry.kind === 'mod' ? { ...entry, ...(await source.modMeta(entry.name)) } : entry)));

// A mod order read mid-write can parse to no entries, and zero mods is legal, so an empty one is
// read again after a settle before it is believed.
async function settledMods(source: ReadingSource, profile: string): Promise<ModlistEntry[]> {
  const mods = await modsWithMeta(source, profile);
  if (mods.length > 0) return mods;
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  return modsWithMeta(source, profile);
}

const withoutRepeats = (names: readonly string[]): string[] => [...new Set(names)];

/** The instance whole, every fact against the one read of the settings, so a profile switch
 *  mid-read cannot mix one profile's mod order with another's plugin order. */
export async function readInstance(source: ReadingSource): Promise<InstanceReading> {
  const settings = await source.settings();
  const { profile, gameName, gameRelease } = settings;
  const skippedLinks = new Map<string, string>();
  const modsRead = settledMods(source, profile);
  const modFoldersRead = source.modFolders((name, reason) => skippedLinks.set(name, reason));
  const sourceModsRead = source.sourceMods();
  const [mods, pluginOrder, downloadedFiles, game, profiles, modFolders, runtimeOutput, sourceMods, ownFacts, folderMeta] = await Promise.all([
    modsRead,
    source.pluginOrder(profile),
    settings.downloadedFiles(),
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
    modsRead.then(async (entries) => {
      const listed = entries.filter((entry) => entry.kind === 'mod');
      const [files, tracked] = await Promise.all([
        Promise.all(listed.map(async ({ name }) => [name, await source.originFiles({ kind: 'mod', name })] as const)),
        Promise.all(listed.map(async ({ name }) => ((await source.modTracked(name)) ? [name] : []))),
      ]);
      return { listed, modFiles: new Map(files), trackedMods: tracked.flat() };
    }),
    modFoldersRead.then((folders) => Promise.all((folders?.all ?? []).filter((folder) => folder.kind === 'mod')
      .map(async ({ name }) => [name, await source.modMeta(name)] as const))),
  ]);
  const { listed, modFiles, trackedMods } = ownFacts;
  const sourceDirs = withoutRepeats([...sourceMods, ...listed.map(({ name }) => name)])
    .flatMap((name) => { const folder = source.sourceFolder(name); return folder === undefined ? [] : [[name, folder] as const]; });
  const { archiveList, dataFolderArchives, ...gameFacts } = game;
  return {
    profile, gameName, gameRelease, mods, pluginOrder, downloadedFiles, ...gameFacts,
    archiveList: archiveList.archives, archiveListNotes: archiveList.notes, dataFolderArchives,
    profiles, modFolders, skippedLinks, runtimeOutput, modFiles, folderMeta: new Map(folderMeta),
    trackedMods, sourceMods, sourceDirs: new Map(sourceDirs),
  };
}

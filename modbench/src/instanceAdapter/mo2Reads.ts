// MO2's parsed reads: each file read through its own codec, and each answer about where the
// instance keeps what.

import { basename, dirname } from 'node:path';
import { parsePlugins } from '../loadOrderFileCodec/pluginsText';
import { DOWNLOAD_SIDECAR_SUFFIX, parseDownloadMeta } from './codecs/downloads';
import { parseMetaIni } from './codecs/metaIni';
import { parseModlist } from './codecs/modlistText';
import { readGameName, readSelectedProfile } from './codecs/modOrganizerIni';
import { creationClubListFile, dataFolderOf, gameReleaseForGame, pluginCompanionRule } from '../tables/gamePaths';
import { factsOf, get, listDir, readOrReason, stampOf } from './files';
import {
  type DataFolderArchives, type DataFolderPlugins, type DownloadedFile, type DownloadedFiles, type FileOrigin, type FileRead, type FileStamp,
  type GameFolder, type InstanceAdapter, type InstanceReading,
  type ModFolders, type ModMeta, type ModlistEntry, type OriginFiles, type PluginEntry, type SourceMods,
} from './instanceAdapter';
import {
  DATA_FOLDER_PLUGINS_GLOB, DOWNLOADS_WATCH_GLOB, downloadFile, entryDir, downloadSidecarFile, fileInFolder, isTempWrite, modlistFile,
  modMetaFile, modSourceDir, pluginsFile, profilesDir, settingsFile,
} from './layout';
import { type ArchiveReads, mo2Archives } from './mo2Archives';
import { entryKey, folderHolding, listModFolders, modFoldersOf, readOrAbsent, type Mo2Context } from './mo2Context';
import { originFilesIn } from './mo2Files';
import { sourceModsIn } from './sourceMods';
import { isPluginFile } from './pluginFile';

interface InstanceSettings {
  readonly profile: string;
  /** The game as the mod manager's configuration names it. */
  readonly gameName: string;
  /** Mutagen's release of that game; undefined when the tables hold none for it. */
  readonly gameRelease: string | undefined;
  gameFolder(): Promise<GameFolder>;
  downloadedFiles(): Promise<DownloadedFiles>;
}

/** What one reading is made of: each file read through its own codec, against the one read of the settings. */
export interface ReadingSource extends ArchiveReads {
  settings(): Promise<InstanceSettings>;
  /** Every profile's name; none when the instance has no profiles. */
  profiles(): Promise<string[]>;
  modOrder(profile: string): Promise<ModlistEntry[]>;
  /** Empty when the mod has no metadata. */
  modMeta(mod: string): Promise<ModMeta>;
  pluginOrder(profile: string): Promise<PluginEntry[]>;
  gameFolderPlugins(gameFolder: GameFolder): Promise<DataFolderPlugins>;
  /** The plugins the game folder's Creation Club list names, in its order; none when the release
   *  has no Creation Club, the game folder is not found, or it holds no list. */
  creationClubList(gameFolder: GameFolder, gameRelease: string | undefined): Promise<string[]>;
  /** Undefined when there is no folder for mods at all. A link that cannot be followed is no
   *  folder, and is handed to `skippedLink`. */
  modFolders(skippedLink?: (name: string, reason: string) => void): Promise<ModFolders | undefined>;
  /** An origin's files, none when its folder is not there. */
  originFiles(origin: FileOrigin): Promise<OriginFiles>;
  sourceMods(): Promise<SourceMods>;
}

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
  const dirents = await readOrReason(() => listDir(dataFolder));
  if (dirents.kind === 'unreadable') return dirents;
  return { kind: 'listed', names: new Set(dirents.answer.filter((d) => d.isFile() && isPluginFile(d.name)).map((d) => d.name)) };
}

// The game writes its Creation Club list in plugins.txt's own line format.
async function readCreationClubList(gameFolder: GameFolder, gameRelease: string | undefined): Promise<string[]> {
  const file = gameFolder.kind === 'found' ? creationClubListFile(gameFolder.root, gameRelease) : undefined;
  if (file === undefined) return [];
  const text = await readOrAbsent<string | undefined>(() => get(file), undefined);
  return text === undefined ? [] : parsePlugins(text).map((entry) => entry.name);
}

// The tables key each release on the game's name as `gameName=` spells it.
const gameOf = (gameName: string) => ({ gameName, gameRelease: gameReleaseForGame(gameName) });

export function readingSource(context: Mo2Context): ReadingSource {
  const { instanceRoot, resolveGameFolder, resolveDownloadsFolder, watch } = context;
  return {
    ...mo2Archives(context),
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

    originFiles: (origin) => originFilesIn(instanceRoot, origin),

    sourceMods: () => sourceModsIn(instanceRoot),
  };
}

export function mo2Reads(context: Mo2Context): Pick<InstanceAdapter, 'modFolderPath' | 'sourceFolder' | 'fileStamp' | 'entryKey'> {
  const { instanceRoot } = context;
  return {
    modFolderPath: async (name) => (await folderHolding(context, { kind: 'mod', name }))?.path ?? entryDir(instanceRoot, { kind: 'mod', name }),
    sourceFolder: (mod) => modSourceDir(instanceRoot, mod),
    entryKey,
    fileStamp: (path) => readOrReason(() => stampOf(path)),
  };
}

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

function archivesAndStringsFiles(
  gameRelease: string | undefined, gameFolder: GameFolder, inData: DataFolderArchives, origins: readonly OriginFiles[],
): string[] {
  const rule = pluginCompanionRule(gameRelease);
  if (rule === undefined) return [];
  const dataFolder = dataFolderOf(gameFolder);
  const inGameFolder = inData.kind === 'listed' && dataFolder !== undefined
    ? [...inData.archives, ...inData.stringsFiles].map((relativePath) => fileInFolder(dataFolder, relativePath))
    : [];
  const inOrigins = origins.flatMap(({ files }) => files)
    .filter(({ excluded, relativePath }) => !excluded && (rule.isArchive(relativePath) || rule.isStringsFile(relativePath)))
    .map(({ sourcePath }) => sourcePath);
  return [...inGameFolder, ...inOrigins];
}

const stampsOf = async (paths: readonly string[]): Promise<Map<string, FileRead<FileStamp>>> =>
  new Map(await Promise.all(paths.map(async (path) => [path, await readOrReason(() => stampOf(path))] as const)));

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
  const archiveAndStringsStamps = await stampsOf(archivesAndStringsFiles(gameRelease, game.gameFolder, dataFolderArchives, [runtimeOutput, ...modFiles.values()]));
  return {
    profile, gameName, gameRelease, mods, pluginOrder, downloadedFiles, ...gameFacts,
    archiveList: archiveList.archives, archiveListNotes: archiveList.notes, dataFolderArchives, archiveAndStringsStamps,
    profiles, modFolders, skippedLinks, runtimeOutput, modFiles, folderMeta,
    sourceMods,
  };
}

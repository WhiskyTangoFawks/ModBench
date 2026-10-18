// MO2's parsed reads: each file read through its own codec, and each answer about where the
// instance keeps what.

import { basename, dirname } from 'node:path';
import { firstLines } from '../loadOrderFileCodec/firstLines';
import { parsePlugins, pluginKey, PLUGINS_FILE_NAME } from '../loadOrderFileCodec/pluginsText';
import { isArchiveName } from './archiveNames';
import { parseDownloadMeta } from './codecs/downloads';
import { parseMetaIni } from './codecs/metaIni';
import { entryNamed, MODLIST_FILE_NAME, modLineKey, parseModlist } from './codecs/modlistText';
import { readGamePath, readSelectedProfile, SETTINGS_FILE_NAME } from './codecs/modOrganizerIni';
import { loadedWithNoLineOf } from '../tables/gamePaths';
import { gameOfSettings } from './mo2Game';
import type { ManagerGamePath } from './gameFolder/gameFolderResolver';
import { creationClubFileOf, dataFolderOf, listDataFolderPlugins, readCreationClubList } from './gameFolder/dataFolder';
import { factsOf, get, isRepository, listEntries, listFolders, readOrAbsent, readOrReason, stampOf } from './files';
import {
  type DataFolderPlugins, type DownloadedFile, type DownloadedFiles, type FileOrigin, type GameFolder, type InstanceAdapter, type InstanceReading,
  type ModFolders, type ModMeta, type ModlistEntry, type OriginFiles, type PluginEntry, type PluginsProvided, type SourceMods,
} from './instanceAdapter';
import {
  DATA_FOLDER_PLUGINS_GLOB, DOWNLOADS_WATCH_GLOB, downloadFile, downloadSidecarFile, isTempWrite, modlistFile,
  modMetaFileIn, modSourceDir, pluginsFile, profilesDir, settingsFile,
} from './layout';
import { type ArchiveReads, mo2Archives } from './mo2Archives';
import { groupModOrder } from './modGroups';
import { entryKey, listModFolders, modFolderNamed, modFoldersOf, type Mo2Context } from './mo2Context';
import { originFilesIn } from './mo2Files';
import { sourceModsIn } from './sourceMods';
import { filesWinningFirst, pluginsProvidedOf } from './pluginsProvided';

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
  /** The files at an origin's root, as `originFiles` lists them. */
  originRootFiles(origin: FileOrigin): Promise<OriginFiles>;
  sourceMods(): Promise<SourceMods>;
  holdsRepository(): Promise<boolean>;
  watchNotes(): string[];
}

async function listDownloadedFiles(downloadsDir: string): Promise<DownloadedFile[] | undefined> {
  const dirents = await readOrAbsent(() => listEntries(downloadsDir), undefined);
  if (dirents === undefined) return undefined;
  const names = dirents
    .filter((d) => d.isFile && isArchiveName(d.name) && !isTempWrite(d.name))
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

const GAME_PATH_PLACE = `${SETTINGS_FILE_NAME}'s gamePath`;

function gamePathOf(iniText: string): string | undefined {
  try {
    return readGamePath(iniText);
  } catch {
    return undefined;
  }
}

export function readingSource(context: Mo2Context): ReadingSource {
  const { instanceRoot, resolveGameFolder, resolveDownloadsFolder, watch } = context;
  return {
    ...mo2Archives(context),
    async settings() {
      const iniText = await get(settingsFile(instanceRoot));
      const game = gameOfSettings(iniText);
      return {
        profile: readSelectedProfile(iniText),
        ...game,
        // What the settings resolve is what the watch follows.
        gameFolder: async () => {
          const managed: ManagerGamePath = { path: gamePathOf(iniText), place: GAME_PATH_PLACE, release: game.gameRelease };
          const gameFolder = await resolveGameFolder(managed);
          watch.follow('gameFolderPlugins', dataFolderOf(gameFolder), DATA_FOLDER_PLUGINS_GLOB);
          const creationClubList = creationClubFileOf(gameFolder, game.gameRelease);
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
      const dirents = await readOrAbsent(() => listFolders(profilesDir(instanceRoot)), []);
      return dirents;
    },

    async modOrder(profile) {
      return parseModlist(await get(modlistFile(instanceRoot, profile)));
    },

    async modMeta(mod) {
      if (entryNamed(mod).kind === 'separator') return {};
      const folder = await modFolderNamed(context, mod);
      return folder === undefined ? {} : readOrAbsent(async () => parseMetaIni(await get(modMetaFileIn(folder))), {});
    },

    modFolders: async (skippedLink) => {
      const all = await listModFolders(context, skippedLink);
      return all === undefined ? undefined : modFoldersOf(all);
    },

    async pluginOrder(profile) {
      return parsePlugins(await get(pluginsFile(instanceRoot, profile)));
    },

    gameFolderPlugins: listDataFolderPlugins,

    creationClubList: readCreationClubList,

    originFiles: (origin) => originFilesIn(context, origin),

    originRootFiles: (origin) => originFilesIn(context, origin, true),

    sourceMods: () => sourceModsIn(instanceRoot),

    holdsRepository: () => isRepository(instanceRoot),
    watchNotes: () => watch.watchNotes(),
  };
}

export function mo2Reads(
  context: Mo2Context, source: ReadingSource,
): Pick<InstanceAdapter, 'modFolderPath' | 'sourceFolder' | 'fileStamp' | 'entryKey' | 'profiles' | 'modOrder' | 'downloadedFiles' | 'sourceMods'> {
  const { instanceRoot } = context;
  return {
    profiles: () => source.profiles(),
    downloadedFiles: async () => (await source.settings()).downloadedFiles(),
    modOrder: async () => ({ mods: await source.modOrder((await source.settings()).profile), modFolders: await listModFolders(context) }),
    sourceMods: () => source.sourceMods(),
    modFolderPath: (name) => modFolderNamed(context, name),
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

const withNotes = <T>(lines: readonly T[], keyOf: (line: T) => string, describe: (line: T) => string): { kept: T[]; notes: string[] } => {
  const { kept, repeats } = firstLines(lines, keyOf);
  return { kept, notes: repeats.map((line) => `${describe(line)} on more than one line; the first line holds`) };
};

async function settled(readModOrder: () => Promise<ModlistEntry[]>): Promise<ModlistEntry[]> {
  const mods = await readModOrder();
  if (mods.length > 0) return mods;
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  return readModOrder();
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
  const modsRead = settled(() => modsWithMeta(source, profile)).then((listed) =>
    withNotes(listed, modLineKey, ({ kind, name }) => `${MODLIST_FILE_NAME} lists the ${kind} ${name}`));
  const modsKept = modsRead.then(({ kept }) => kept);
  const modFoldersRead = source.modFolders((name, reason) => skippedLinks.set(name, reason));
  const sourceModsRead = source.sourceMods();
  const downloadsRead = settings.downloadedFiles();
  const [mods, pluginsListed, downloadedFiles, game, profiles, modFolders, runtimeOutput, sourceMods, modFiles, folderMeta, holdsRepository] = await Promise.all([
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
    modsKept.then(async (entries) => new Map(await Promise.all(entries.filter((entry) => entry.kind === 'mod')
      .map(async ({ name }) => [name, await source.originFiles({ kind: 'mod', name })] as const)))),
    Promise.all([modsKept, modFoldersRead, downloadsRead]).then(([entries, folders, downloads]) =>
      folderMetaOf(source, entries, folders, downloads.kind === 'listed' && downloads.files !== undefined)),
    source.holdsRepository(),
  ]);
  const { archiveList, dataFolderArchives, ...gameFacts } = game;
  const pluginOrder = withNotes(pluginsListed, ({ name }) => pluginKey(name), ({ name }) => `${PLUGINS_FILE_NAME} lists the plugin ${name}`);
  return {
    profile, gameName, gameRelease, mods: mods.kept, modGroups: groupModOrder(mods.kept), pluginOrder: pluginOrder.kept, orderNotes: [...mods.notes, ...pluginOrder.notes], downloadedFiles, ...gameFacts,
    archiveList: archiveList.archives, archiveListNotes: archiveList.notes, dataFolderArchives,
    profiles, modFolders, skippedLinks, runtimeOutput, modFiles, folderMeta,
    sourceMods, holdsRepository, watchNotes: source.watchNotes(),
  };
}

/** The plugins `profile`'s mod order provides, the game folder's against one read of the settings. */
export async function readPluginsProvided(source: ReadingSource, profile: string): Promise<PluginsProvided> {
  const settings = await source.settings();
  const [mods, runtimeOutput, gameFolder] = await Promise.all([
    settled(() => source.modOrder(profile)).then((listed) => firstLines(listed, modLineKey).kept),
    source.originRootFiles({ kind: 'runtimeOutput' }),
    settings.gameFolder(),
  ]);
  const [modFiles, dataFolderPlugins, creationClubList] = await Promise.all([
    Promise.all(filesWinningFirst(mods, [], () => []).flatMap(({ origin }) => (origin.kind === 'mod' ? [origin] : []))
      .map(async (origin) => [origin.name, (await source.originRootFiles(origin)).files] as const)).then((listed) => new Map(listed)),
    source.gameFolderPlugins(gameFolder),
    source.creationClubList(gameFolder, settings.gameRelease),
  ]);
  return pluginsProvidedOf(
    filesWinningFirst(mods, runtimeOutput.files, (mod) => modFiles.get(mod) ?? []), dataFolderPlugins,
    loadedWithNoLineOf(settings.gameRelease, creationClubList),
  );
}

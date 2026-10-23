// The reading a mod manager supplies and the neutral assembly of the instance from it: the settle,
// the repeated-line notes and the folder meta.

import { firstLines } from '../loadOrderFileCodec/firstLines';
import { pluginKey, PLUGINS_FILE_NAME } from '../loadOrderFileCodec/pluginsText';
import { ignoreSkippedLink, type SkippedLink } from './files';
import {
  filesWinningFirst, type DataFolderArchives, type DataFolderPlugins, type DownloadedFiles, type EntryRef, type FileOrigin, type GameFolder,
  type ManagerNames, type ManagerRunning, type ModFolders, type ModMeta, type ModlistEntry, type OriginFiles, type PluginEntry, type PluginsProvided, type SourceMods,
} from './instanceAdapter';
import { groupModOrder } from './modGroups';
import type { ManagerReading } from './publisher';
import { pluginsProvidedOf } from './pluginsProvided';
import { loadedWithNoLineOf } from '../tables/gamePaths';

export interface ArchiveReads {
  /** The archives the game's INIs list, in load order, a key's last value winning. `notes` says what
   *  was not read, and where it looked. */
  archiveList(
    profile: string, gameFolder: GameFolder, gameRelease: string | undefined,
  ): Promise<{ readonly archives: readonly string[]; readonly notes: readonly string[] }>;
  gameFolderArchives(gameFolder: GameFolder, gameRelease: string | undefined, skippedLink: SkippedLink): Promise<DataFolderArchives>;
}


interface InstanceSettings {
  readonly profile: string;
  /** The game as the mod manager's configuration names it. */
  readonly gameName: string;
  /** Mutagen's release of that game. */
  readonly gameRelease: string;
  gameFolder(): Promise<GameFolder>;
  downloadedFiles(skippedLink: SkippedLink): Promise<DownloadedFiles>;
}

/** What one reading is made of: each file read through its own codec, against the one read of the settings. */
export interface ReadingSource extends ArchiveReads {
  readonly names: ManagerNames;
  /** The key two lines of the mod order are the same line by. */
  readonly modLineKey: (entry: EntryRef) => string;
  settings(): Promise<InstanceSettings>;
  /** Every profile's name; none when the instance has no profiles. */
  profiles(skippedLink: SkippedLink): Promise<string[]>;
  modOrder(profile: string): Promise<ModlistEntry[]>;
  /** Empty when the mod has no metadata. */
  modMeta(mod: string, folders: ModFolders | undefined | 'list'): Promise<ModMeta>;
  pluginOrder(profile: string): Promise<PluginEntry[]>;
  gameFolderPlugins(gameFolder: GameFolder, skippedLink: SkippedLink): Promise<DataFolderPlugins>;
  /** The plugins the game folder's Creation Club list names, in its order; none when the release
   *  has no Creation Club, the game folder is not found, or it holds no list. */
  creationClubList(gameFolder: GameFolder, gameRelease: string | undefined): Promise<string[]>;
  /** Undefined when there is no folder for mods at all. A link that cannot be followed is no
   *  folder, and is handed to `skippedLink`. */
  modFolders(skippedLink: SkippedLink): Promise<ModFolders | undefined>;
  /** An origin's files, none when its folder is not there. */
  originFiles(origin: FileOrigin, folders: ModFolders | undefined | 'list'): Promise<OriginFiles>;
  /** The files at an origin's root, as `originFiles` lists them. */
  originRootFiles(origin: FileOrigin, folders: ModFolders | undefined | 'list'): Promise<OriginFiles>;
  sourceMods(): Promise<SourceMods>;
  holdsRepository(): Promise<boolean>;
  repositorySetUp(): Promise<boolean>;
  watchNotes(): string[];
  managerRunning(): Promise<ManagerRunning>;
}

// How long another tool's write takes to settle before an empty mod order is believed.
const SETTLE_MS = 200;

const modsWithMeta = async (source: ReadingSource, profile: string, folders: Promise<ModFolders | undefined>): Promise<ModlistEntry[]> =>
  Promise.all((await source.modOrder(profile)).map(async (entry) =>
    (entry.kind === 'mod' ? { ...entry, ...(await source.modMeta(entry.name, await folders)) } : entry)));

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

const metaOf = ({ version, nexusId, installationFileName, installedFileKeys }: ModMeta): ModMeta =>
  ({ version, nexusId, installationFileName, installedFileKeys });

// A listed mod's meta is the one already read. A folder the mod order does not list is read only
// when downloaded files are there to be matched against it.
async function folderMetaOf(
  source: ReadingSource, entries: readonly ModlistEntry[], folders: ModFolders | undefined, downloadedFilesListed: boolean,
): Promise<ReadonlyMap<string, ModMeta>> {
  const read = new Map(entries.flatMap((entry) => (entry.kind === 'mod' ? [[entry.name, metaOf(entry)] as const] : [])));
  const unlisted = downloadedFilesListed
    ? (folders?.all ?? []).filter((folder) => folder.kind === 'mod' && !read.has(folder.name))
    : [];
  const unlistedMetas = await Promise.all(unlisted.map(async ({ name }) => [name, await source.modMeta(name, folders)] as const));
  return new Map([...read, ...unlistedMetas]);
}

/** The instance whole, every fact against the one read of the settings, so a profile switch
 *  mid-read cannot mix one profile's mod order with another's plugin order. */
export async function readInstance(source: ReadingSource): Promise<ManagerReading> {
  const settings = await source.settings();
  const { profile, gameName, gameRelease } = settings;
  const skippedLinks = new Map<string, string>();
  const skipLink: SkippedLink = (linkPath, reason) => skippedLinks.set(linkPath, reason);
  const modFoldersRead = source.modFolders(skipLink);
  const modsRead = settled(() => modsWithMeta(source, profile, modFoldersRead)).then((listed) =>
    withNotes(listed, source.modLineKey, ({ kind, name }) => `${source.names.modOrderFile} lists the ${kind} ${name}`));
  const modsKept = modsRead.then(({ kept }) => kept);
  const sourceModsRead = source.sourceMods();
  const downloadedFilesRead = settings.downloadedFiles(skipLink);
  const [mods, pluginsListed, downloadedFiles, game, profiles, modFolders, runtimeOutput, sourceMods, modFiles, folderMeta, holdsRepository, repositorySetUp, managerRunning] = await Promise.all([
    modsRead,
    source.pluginOrder(profile),
    downloadedFilesRead,
    settings.gameFolder().then(async (gameFolder) => ({
      gameFolder,
      dataFolderPlugins: await source.gameFolderPlugins(gameFolder, skipLink),
      creationClubList: await source.creationClubList(gameFolder, gameRelease),
      archiveList: await source.archiveList(profile, gameFolder, gameRelease),
      dataFolderArchives: await source.gameFolderArchives(gameFolder, gameRelease, skipLink),
    })),
    source.profiles(skipLink),
    modFoldersRead,
    source.originFiles({ kind: 'runtimeOutput' }, 'list'),
    sourceModsRead,
    Promise.all([modsKept, modFoldersRead]).then(async ([entries, folders]) => new Map(await Promise.all(entries.filter((entry) => entry.kind === 'mod')
      .map(async ({ name }) => [name, await source.originFiles({ kind: 'mod', name }, folders)] as const)))),
    Promise.all([modsKept, modFoldersRead, downloadedFilesRead]).then(([entries, folders, downloadedFiles]) =>
      folderMetaOf(source, entries, folders, downloadedFiles.kind === 'listed' && downloadedFiles.files !== undefined)),
    source.holdsRepository(),
    source.repositorySetUp(),
    source.managerRunning(),
  ]);
  const { archiveList, dataFolderArchives, ...gameFacts } = game;
  const pluginOrder = withNotes(pluginsListed, ({ name }) => pluginKey(name), ({ name }) => `${PLUGINS_FILE_NAME} lists the plugin ${name}`);
  return {
    profile, gameName, gameRelease, mods: mods.kept, modGroups: groupModOrder(mods.kept), pluginOrder: pluginOrder.kept, orderNotes: [...mods.notes, ...pluginOrder.notes], downloadedFiles, ...gameFacts,
    archiveList: archiveList.archives, archiveListNotes: archiveList.notes, dataFolderArchives,
    profiles, modFolders, runtimeOutput, modFiles, folderMeta,
    sourceMods, holdsRepository, repositorySetUp, watchNotes: source.watchNotes(), managerRunning,
    linkNotes: [...skippedLinks].map(([linkPath, reason]) => `${linkPath} is a link Modbench cannot follow, so it is not read: ${reason}`),
  };
}

/** The plugins `profile`'s mod order provides, the game folder's against one read of the settings. */
export async function readPluginsProvided(source: ReadingSource, profile: string): Promise<PluginsProvided> {
  const settings = await source.settings();
  const [mods, runtimeOutput, gameFolder, modFolders] = await Promise.all([
    settled(() => source.modOrder(profile)).then((listed) => firstLines(listed, source.modLineKey).kept),
    source.originRootFiles({ kind: 'runtimeOutput' }, 'list'),
    settings.gameFolder(),
    source.modFolders(ignoreSkippedLink),
  ]);
  const [modFiles, dataFolderPlugins, creationClubList] = await Promise.all([
    Promise.all(filesWinningFirst(mods, [], () => []).flatMap(({ origin }) => (origin.kind === 'mod' ? [origin] : []))
      .map(async (origin) => [origin.name, (await source.originRootFiles(origin, modFolders)).files] as const)).then((listed) => new Map(listed)),
    source.gameFolderPlugins(gameFolder, ignoreSkippedLink),
    source.creationClubList(gameFolder, settings.gameRelease),
  ]);
  return pluginsProvidedOf(
    filesWinningFirst(mods, runtimeOutput.files, (mod) => modFiles.get(mod) ?? []), dataFolderPlugins,
    loadedWithNoLineOf(settings.gameRelease, creationClubList),
  );
}

// The reading a mod manager supplies and the neutral assembly of the instance from it: the settle,
// the repeated-line notes and the folder meta.

import { firstLines } from '../loadOrderFileCodec/firstLines';
import { pluginKey, PLUGINS_FILE_NAME } from '../loadOrderFileCodec/pluginsText';
import { pathKey } from '../repositoriesLib/stampedReads';
import { ignoreSkippedLink, readTrustingKept, trustingKept, type SkippedLink } from './files';
import {
  CHECK_THE_DISK, filesWinningFirst, type Reread, type DataFolderArchives, type DataFolderFiles, type DataFolderPlugins, type DownloadedFiles, type EntryRef, type FileOrigin, type GameFolder,
  type ManagerNames, type ManagerRunning, type ModFolders, type ModMeta, type ModlistEntry, type OriginFiles, type PluginEntry, type PluginsProvided,
  type SortingRuleFiles, type UnwatchedFolder,
} from './instanceAdapter';
import { groupModOrder } from './modGroups';
import type { ManagerReading } from './publisher';
import { pluginsProvidedOf } from './pluginsProvided';
import { loadedWithNoLineOf } from '../tables/gamePaths';
import { originsWinningFirst } from '../symbolNames/symbolNames';
import { ignoreLink, type IgnoredLink } from './gameFolder/ownEntries';
import { programVersions } from './gameFolder/programVersions';
import { lastBuilt } from '../ports/lastBuilt';
import { readingSteadier } from './steadyReading';

export interface ArchiveReads {
  /** The archives the game's INIs list, in load order, a key's last value winning. `notes` says what
   *  was not read, and where it looked. */
  archiveList(
    profile: string, gameFolder: GameFolder, gameRelease: string | undefined, ignoredLink: IgnoredLink,
  ): Promise<{ readonly archives: readonly string[]; readonly notes: readonly string[] }>;
  gameFolderArchives(gameFolder: GameFolder, gameRelease: string | undefined, ignoredLink: IgnoredLink): Promise<DataFolderArchives>;
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
  gameFolderPlugins(gameFolder: GameFolder, ignoredLink: IgnoredLink): Promise<DataFolderPlugins>;
  gameFolderFiles(gameFolder: GameFolder, ignoredLink: IgnoredLink): Promise<DataFolderFiles>;
  /** The plugins the Creation Club list the game gets names, in its order: the copy the first of `origins` deploys, else
   *  the game folder's own; none when the release has no Creation Club or no game folder is found. */
  creationClubList(
    gameFolder: GameFolder, gameRelease: string | undefined, origins: readonly FileOrigin[], folders: ModFolders | undefined,
    ignoredLink: IgnoredLink, skippedLink: SkippedLink,
  ): Promise<string[]>;
  /** Undefined when there is no folder for mods at all. A link that cannot be followed is no
   *  folder, and is handed to `skippedLink`. */
  modFolders(skippedLink: SkippedLink): Promise<ModFolders | undefined>;
  /** An origin's files, none when its folder is not there. */
  originFiles(origin: FileOrigin, folders: ModFolders | undefined | 'list'): Promise<OriginFiles>;
  /** The files at an origin's root, as `originFiles` lists them. */
  originRootFiles(origin: FileOrigin, folders: ModFolders | undefined | 'list'): Promise<OriginFiles>;
  sourceModFolders(): Promise<ReadonlyMap<string, string>>;
  sortingRuleFiles(): Promise<SortingRuleFiles>;
  holdsRepository(): Promise<boolean>;
  repositorySetUp(): Promise<boolean>;
  unwatchedFolders(): UnwatchedFolder[];
  managerRunning(): Promise<ManagerRunning>;
}

// How long another tool's write takes to settle before an empty mod order is believed.
const SETTLE_MS = 200;

interface ModOrderRead {
  readonly listed: readonly ModlistEntry[];
  readonly metas: readonly (ModMeta | undefined)[];
}

const readModOrder = async (source: ReadingSource, profile: string, folders: Promise<ModFolders | undefined>): Promise<ModOrderRead> => {
  const listed = await source.modOrder(profile);
  return { listed, metas: await Promise.all(listed.map(async (entry) => (entry.kind === 'mod' ? source.modMeta(entry.name, await folders) : undefined))) };
};

const withNotes = <T>(lines: readonly T[], keyOf: (line: T) => string, describe: (line: T) => string): { kept: T[]; notes: string[] } => {
  const { kept, repeats } = firstLines(lines, keyOf);
  return { kept, notes: repeats.map((line) => `${describe(line)} on more than one line; the first line holds`) };
};

async function settled<T>(read: () => Promise<T>, lines: (read: T) => readonly unknown[]): Promise<T> {
  const order = await read();
  if (lines(order).length > 0) return order;
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  return read();
}

const metaOf = ({ version, nexusId, installationFileName, installedFileKeys }: ModMeta): ModMeta =>
  ({ version, nexusId, installationFileName, installedFileKeys });

const steadiers = new WeakMap<ReadingSource, { readonly steadied: ReturnType<typeof readingSteadier>; readonly pluginOrder: (listed: PluginEntry[]) => { kept: PluginEntry[]; notes: string[] }; readonly modGroups: typeof groupModOrder }>();

const steadierOf = (source: ReadingSource) => {
  const steadier = steadiers.get(source) ?? {
    steadied: readingSteadier(),
    pluginOrder: lastBuilt((listed: PluginEntry[]) => withNotes(listed, ({ name }) => pluginKey(name), ({ name }) => `${PLUGINS_FILE_NAME} lists the plugin ${name}`)),
    modGroups: lastBuilt(groupModOrder),
  };
  steadiers.set(source, steadier);
  return steadier;
};

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
export async function readInstance(source: ReadingSource, { named, disk }: Reread = CHECK_THE_DISK): Promise<ManagerReading> {
  const { answer, unheard, unchanged } = await readTrustingKept(named, disk, () => readWhole(source));
  return { ...answer, unheardChanges: unheard, unchangedFiles: named.filter((path) => unchanged.has(pathKey(path))), trustingKept };
}

async function readWhole(source: ReadingSource): Promise<Omit<ManagerReading, 'unheardChanges' | 'unchangedFiles' | 'trustingKept'>> {
  const settings = await source.settings();
  const { profile, gameName, gameRelease } = settings;
  const skippedLinks = new Map<string, string>();
  const skipLink: SkippedLink = (linkPath, reason) => skippedLinks.set(linkPath, reason);
  const gameFolderLinks = new Set<string>();
  const ignoreGameLink: IgnoredLink = (linkPath) => gameFolderLinks.add(linkPath);
  const modFoldersRead = source.modFolders(skipLink);
  const modOrderRead = settled(() => readModOrder(source, profile, modFoldersRead), ({ listed }) => listed);
  const modsRead = modOrderRead.then(({ listed, metas }) =>
    withNotes(listed.map((entry, at) => ({ ...entry, ...metas[at] })), source.modLineKey, ({ kind, name }) => `${source.names.modOrderFile} lists the ${kind} ${name}`));
  const modsKept = modsRead.then(({ kept }) => kept);
  const downloadedFilesRead = settings.downloadedFiles(skipLink);
  const [mods, pluginsListed, downloadedFiles, game, profiles, modFolders, runtimeOutput, sourceModFolders, sortingRuleFiles, modFiles, folderMeta, holdsRepository, repositorySetUp, managerRunning] = await Promise.all([
    modsRead,
    source.pluginOrder(profile),
    downloadedFilesRead,
    settings.gameFolder().then(async (gameFolder) => ({
      gameFolder,
      programVersions: await programVersions(gameFolder, gameRelease),
      dataFolderPlugins: await source.gameFolderPlugins(gameFolder, ignoreGameLink),
      creationClubList: await source.creationClubList(gameFolder, gameRelease, originsWinningFirst(await modsKept), await modFoldersRead, ignoreGameLink, skipLink),
      archiveList: await source.archiveList(profile, gameFolder, gameRelease, ignoreGameLink),
      dataFolderArchives: await source.gameFolderArchives(gameFolder, gameRelease, ignoreGameLink),
      dataFolderFiles: await source.gameFolderFiles(gameFolder, ignoreGameLink),
    })),
    source.profiles(skipLink),
    modFoldersRead,
    source.originFiles({ kind: 'runtimeOutput' }, 'list'),
    source.sourceModFolders(),
    source.sortingRuleFiles(),
    Promise.all([modsKept, modFoldersRead]).then(async ([entries, folders]) => new Map(await Promise.all(entries.filter((entry) => entry.kind === 'mod')
      .map(async ({ name }) => [name, await source.originFiles({ kind: 'mod', name }, folders)] as const)))),
    Promise.all([modsKept, modFoldersRead, downloadedFilesRead]).then(([entries, folders, downloadedFiles]) =>
      folderMetaOf(source, entries, folders, downloadedFiles.kind === 'listed' && downloadedFiles.files !== undefined)),
    source.holdsRepository(),
    source.repositorySetUp(),
    source.managerRunning(),
  ]);
  const { listed, metas } = await modOrderRead;
  const steadier = steadierOf(source);
  const steady = steadier.steadied({
    ...game, archiveList: game.archiveList.archives, mods, modsReadFrom: [listed, ...metas], downloadedFiles, profiles, modFolders, sourceModFolders,
    sortingRuleFiles, unwatchedFolders: source.unwatchedFolders(), managerRunning, modFiles, folderMeta,
  });
  const pluginOrder = steadier.pluginOrder(pluginsListed);
  return {
    profile, gameName, gameRelease, ...steady, mods: steady.mods.kept, modGroups: steadier.modGroups(steady.mods.kept), pluginOrder: pluginOrder.kept,
    orderNotes: [...mods.notes, ...pluginOrder.notes], archiveListNotes: game.archiveList.notes, runtimeOutput, holdsRepository, repositorySetUp,
    gameFolderLinks: gameFolderLinks.size,
    linkNotes: [...skippedLinks].map(([linkPath, reason]) => `${linkPath} is a link Modbench cannot follow, so it is not read: ${reason}`),
  };
}

/** The plugins `profile`'s mod order provides, the game folder's against one read of the settings. */
export async function readPluginsProvided(source: ReadingSource, profile: string): Promise<PluginsProvided> {
  const settings = await source.settings();
  const [mods, runtimeOutput, gameFolder, modFolders] = await Promise.all([
    settled(() => source.modOrder(profile), (listed) => listed).then((listed) => firstLines(listed, source.modLineKey).kept),
    source.originRootFiles({ kind: 'runtimeOutput' }, 'list'),
    settings.gameFolder(),
    source.modFolders(ignoreSkippedLink),
  ]);
  const [modFiles, dataFolderPlugins, creationClubList] = await Promise.all([
    Promise.all(filesWinningFirst(mods, [], () => []).flatMap(({ origin }) => (origin.kind === 'mod' ? [origin] : []))
      .map(async (origin) => [origin.name, (await source.originRootFiles(origin, modFolders)).files] as const)).then((listed) => new Map(listed)),
    source.gameFolderPlugins(gameFolder, ignoreLink),
    source.creationClubList(gameFolder, settings.gameRelease, originsWinningFirst(mods), modFolders, ignoreLink, ignoreSkippedLink),
  ]);
  return pluginsProvidedOf(
    filesWinningFirst(mods, runtimeOutput.files, (mod) => modFiles.get(mod) ?? []), dataFolderPlugins,
    loadedWithNoLineOf(settings.gameRelease, creationClubList),
  );
}

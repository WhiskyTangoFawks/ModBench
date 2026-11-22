// The instance value's facts, each built again only when a fact it is built from is another object.

import { asLanded, lastBuilt } from '../ports/lastBuilt';
import {
  foldPath, gameFolderArchivedOf, indexReusing, sliceReusing, stackReusing, type FileConflictIndex, type FileWinners, type GameFolderArchived, type LoadedArchive,
} from './fileConflictIndex';
import {
  archivesGameLoads, archivesInLoadOrder, buildLoadOrderRows, loadOrderSnapshotOf, pluginsLoadedWithNoLineOf, snapshotStamper, type ArchiveSources,
  type DataFolderFiles, type LoadOrderPlugin, type LoadOrderPluginLine, type PluginWithNoLine,
} from './loadOrderSnapshot';
import { OVERWRITE_ORIGIN } from '../wire/pluginAddress';
import { modNamesOf } from './modName';
import { buildDownloadedFileRows, modsByInstallationFileName } from './downloadedFileRows';
import { blueprintLoadsLastIn, loadedWithNoLineOf, nexusDomainForMetaGame, papyrusScriptAt, pluginCompanionRule } from '../tables/gamePaths';
import { isPluginAtRoot } from '../tables/pluginFile';
import {
  fileInFolder, type DataFolderArchives, type DataFolderPlugins, type DownloadedFiles, type GameFolder, type InstanceAdapter, type InstanceReading, type ModFolders,
  type ModlistEntry, type ModMeta, type OriginFile,
} from '../instanceAdapter/instanceAdapter';
import { sourceModsOf, type SourceMods } from '../manifestAdapter/manifestAdapter';
import { pluginPlacesOf } from './pluginPlacesOf';
import { archivedPathsOf, papyrusScriptsOf } from './papyrusScripts';
import { flaggedPluginsIn, type FlaggedHashesHeld } from './flaggedHashes';
import { archivePathsIn, type ArchiveContentsHeld, type ArchiveRead } from './archiveContents';
import { pluginOrderOf, unplaced } from './pluginOrder';
import type { InstancePaths, InstanceValue } from './instance';

/** What the facts are told of as they are built, for the Output. */
export interface FactsTold {
  sourceMods(sourceMods: SourceMods): void;
  archiveSources(sources: ArchiveSources): void;
  archiveContents(reads: ReadonlyMap<string, ArchiveRead>): void;
}

type Rows = readonly (LoadOrderPlugin | LoadOrderPluginLine)[];
type Loaded = ReturnType<typeof archivesGameLoads>;

// A listed source mod under its name in the mod order, an unlisted one under the name its folder gives it.
function sourceDirsOf(entries: readonly ModlistEntry[], sourceMods: SourceMods): Map<string, string> {
  const listed = entries.flatMap((entry) => {
    const folder = entry.kind === 'mod' ? sourceMods.folderOf(entry.name) : undefined;
    return folder === undefined ? [] : [[entry.name, folder] as const];
  });
  const claimed = new Set(listed.map(([, folder]) => folder));
  return new Map([...listed, ...[...sourceMods.folders].filter(([, folder]) => !claimed.has(folder))]);
}

// Each listed mod's folder is matched as the manager matches names.
const pathsOf = (
  overwriteDir: string | undefined, downloadsDir: string | undefined, entries: readonly ModlistEntry[], modFolders: ModFolders | undefined, sourceMods: SourceMods,
): InstancePaths => ({
  overwriteDir,
  downloadsDir,
  modDirs: new Map(entries.flatMap((entry) => {
    const folder = entry.kind === 'mod' ? modFolders?.holding(entry) : undefined;
    return folder === undefined ? [] : [[entry.name, folder.path] as const];
  })),
  sourceDirs: sourceDirsOf(entries, sourceMods),
});

// Installed reads every mod folder, not one profile's mod order: a folder no profile has synced into its mod order yet
// still owns its meta's claim.
const installedIntoOf = (folderMeta: ReadonlyMap<string, ModMeta>): ReturnType<typeof modsByInstallationFileName> =>
  modsByInstallationFileName([...folderMeta].map(([name, meta]) => ({ name, installationFileName: meta.installationFileName })));

const sourceModsIn = (entries: readonly ModlistEntry[], sourceDirs: ReadonlyMap<string, string>): Pick<InstanceValue, 'listedSourceMods' | 'sourceMods'> => ({
  listedSourceMods: new Set(entries.flatMap((entry) => (entry.kind === 'mod' && sourceDirs.has(entry.name) ? [entry.name] : []))),
  sourceMods: new Set(sourceDirs.keys()),
});

const archiveSourcesOf = (gameRelease: string, listed: readonly string[], inData: DataFolderArchives, index: FileConflictIndex, overwrite: readonly OriginFile[]): ArchiveSources => ({
  gameRelease, listed, inData, files: index.files, filesByOrigin: new Map([...index.filesByMod, [OVERWRITE_ORIGIN, overwrite]]),
});

const downloadedFilesOf = (
  downloaded: DownloadedFiles, installedInto: ReturnType<typeof installedIntoOf>, entries: readonly ModlistEntry[], sourceDirs: ReadonlyMap<string, string>,
): InstanceValue['downloadedFiles'] => (downloaded.kind === 'unresolved'
  ? { kind: 'unresolved', reason: downloaded.reason }
  : { kind: 'listed', rows: downloaded.files ? buildDownloadedFileRows(downloaded.files, installedInto, entries, new Set(sourceDirs.keys())) : [] });

// The active plugins, the archives the game loads from the Data folder in load order, the game folder's of them, and every
// archive whose contents are read.
function archivesToReadOf({ gameRelease, listed, inData, files, filesByOrigin }: ArchiveSources, plugins: Rows, noLine: readonly PluginWithNoLine[] | undefined, dataFolder: string | undefined) {
  const { loadedWithNoLine, fromLines } = pluginOrderOf({ plugins, pluginsLoadedWithNoLine: noLine ?? [] }, unplaced);
  const active = [...loadedWithNoLine, ...fromLines.filter((plugin) => plugin.enabled && plugin.path !== undefined)].map(({ name, origin }) => ({ name, origin }));
  const inLoadOrder = dataFolder === undefined ? [] : archivesInLoadOrder({ gameRelease, listed, inData, files, filesByOrigin }, dataFolder, active);
  const gameArchives = new Set(inData.kind === 'listed' && dataFolder !== undefined ? inData.archives.map((name) => fileInFolder(dataFolder, name)) : []);
  const toRead = [...archivePathsIn(gameRelease, [...filesByOrigin.values()].flat()), ...inLoadOrder.filter((archive) => gameArchives.has(archive))];
  return { active, inLoadOrder, gameArchives, toRead };
}

const loadsArchiveOf = (loaded: Loaded): ((name: string) => boolean) => {
  const names = new Set(loaded.map(({ relativePath }) => foldPath(relativePath)));
  return (name) => names.has(foldPath(name));
};

const gameFolderArchivedIn = (archives: ReturnType<typeof archivesToReadOf>, contents: ReadonlyMap<string, ArchiveRead>, gameRelease: string): GameFolderArchived =>
  gameFolderArchivedOf(archives.inLoadOrder.map((archive) => {
    const read = contents.get(archive);
    return { archive, ...archives.gameArchives.has(archive) && read?.kind === 'read' && { gameFolderFiles: read.answer } };
  }), gameRelease);

const papyrusScriptsIn = (files: FileWinners, dataFolderFiles: DataFolderFiles, gameRelease: string, loaded: readonly LoadedArchive[], gameFolderArchived: GameFolderArchived) =>
  papyrusScriptsOf(files, dataFolderFiles, gameRelease, archivedPathsOf({ loaded, gameFolderArchived }));

// What each archive the game loads holds, nothing known of one that cannot be read.
const loadedArchivesOf = (loaded: Loaded, contents: ReadonlyMap<string, ArchiveRead>): LoadedArchive[] => loaded.map(({ winner, winnerOrigin }) => {
  const read = contents.get(winner);
  return { origin: winnerOrigin, archive: winner, files: read?.kind === 'read' ? read.answer : undefined };
});

// The archives and strings files the game loads beside a plugin.
const archiveOrStringsIn = (gameRelease: string) => {
  const rule = pluginCompanionRule(gameRelease);
  return ({ relativePath }: OriginFile): boolean => rule !== undefined && (rule.isArchive(relativePath) || rule.isStringsFile(relativePath));
};

const noLineOf = (gameRelease: string, creationClub: readonly string[], inData: DataFolderPlugins, plugins: Rows, gameFolder: GameFolder) =>
  pluginsLoadedWithNoLineOf(loadedWithNoLineOf(gameRelease, creationClub), inData, plugins, gameFolder);

const snapshotOf = (
  plugins: Rows, gameFolder: GameFolder, pluginsLoadedWithNoLine: readonly PluginWithNoLine[] | undefined, modFolders: ModFolders | undefined, entries: readonly ModlistEntry[],
  paths: InstancePaths, archives: ArchiveSources,
) => loadOrderSnapshotOf({ plugins, gameFolder, pluginsLoadedWithNoLine, modFolders, sourceDirs: paths.sourceDirs, places: pluginPlacesOf({ mods: entries, paths }), archives });

/** Builds the instance value from each reading. */
export class FactsOfReading {
  private readonly index = indexReusing();
  private readonly rootPlugins = sliceReusing(({ relativePath }) => isPluginAtRoot(relativePath));
  private readonly archivesAndStrings = lastBuilt((gameRelease: string) => sliceReusing(archiveOrStringsIn(gameRelease)));
  private readonly scripts = lastBuilt((gameRelease: string) => sliceReusing(({ relativePath }) => papyrusScriptAt(gameRelease, relativePath) !== undefined));
  private readonly stack = stackReusing();
  private readonly plugins = lastBuilt(buildLoadOrderRows);
  private readonly noLine = lastBuilt(noLineOf);
  private readonly installedInto = lastBuilt(installedIntoOf);
  private readonly modNames = lastBuilt(modNamesOf);
  private readonly paths = lastBuilt(pathsOf);
  private readonly sourceMods = lastBuilt(sourceModsIn);
  private readonly archiveSources = lastBuilt(archiveSourcesOf);
  private readonly archivesToRead = lastBuilt(archivesToReadOf);
  private readonly loaded = lastBuilt((sources: ArchiveSources, active: ReturnType<typeof archivesToReadOf>['active']) =>
    archivesGameLoads(sources.gameRelease, sources.listed, active, sources.files));
  private readonly loadsArchive = lastBuilt(loadsArchiveOf);
  private readonly loadedArchives = lastBuilt(loadedArchivesOf);
  private readonly gameFolderArchived = lastBuilt(gameFolderArchivedIn);
  private readonly papyrusScripts = lastBuilt(papyrusScriptsIn);
  private readonly snapshot = lastBuilt(snapshotOf);
  private readonly downloadedFiles = lastBuilt(downloadedFilesOf);
  private readonly stamped = snapshotStamper();
  private readonly linkTargets = lastBuilt((index: FileConflictIndex, overwrite: readonly OriginFile[]): ReadonlySet<string> =>
    new Set([...[...index.filesByMod.values()].flat(), ...overwrite].flatMap(({ path, sourcePath }) => (sourcePath === path ? [] : [sourcePath]))));
  private readonly modKey = (name: string): string => this.entryKey({ kind: 'mod', name });
  // The source mods each reading made: a reading keeps those of the reading its value landed from while the two read the same.
  private readonly sourceModsRead = new WeakMap<InstanceReading, SourceMods>();

  constructor(
    private readonly adapter: Pick<InstanceAdapter, 'names' | 'publisherTags' | 'ownPath' | 'fileStamp'>, private readonly entryKey: InstanceValue['entryKey'],
    private readonly archives: ArchiveContentsHeld, private readonly flagged: FlaggedHashesHeld,
  ) {}

  /** The value `reading` makes, with the workspace's Data folder: the game folder's when the workspace holds it. `landedFrom` is
   *  the reading the value last landed from. */
  async of(reading: InstanceReading, dataFolder: string | undefined, told: FactsTold, landedFrom?: InstanceReading): Promise<InstanceValue> {
    const { mods: entries, gameRelease, gameFolder, dataFolderPlugins, modFolders, runtimeOutput, downloadedFiles, trustingKept } = reading;
    const sourceMods = asLanded(await trustingKept(() => sourceModsOf(modFolders?.all, reading.sourceModFolders, this.modKey)), landedFrom && this.sourceModsRead.get(landedFrom));
    this.sourceModsRead.set(reading, sourceMods);
    told.sourceMods(sourceMods);
    const index = this.index(entries, runtimeOutput.files, reading.modFiles);
    const linkTargets = this.linkTargets(index, runtimeOutput.files);
    // No watch follows the target of a link, so its stamp is taken afresh at each read.
    const stampOf = (path: string) => (linkTargets.has(path) ? this.adapter.fileStamp(path) : trustingKept(() => this.adapter.fileStamp(path)));
    const roots = this.rootPlugins(entries, runtimeOutput.files, reading.modFiles);
    const plugins = this.plugins(reading.pluginOrder, roots.index, roots.overwrite, gameFolder, dataFolderPlugins);
    const pluginsLoadedWithNoLine = this.noLine(gameRelease, reading.creationClubList, dataFolderPlugins, plugins, gameFolder);
    const paths = this.paths(runtimeOutput.folder, downloadedFiles.kind === 'listed' ? downloadedFiles.downloadsDir : undefined, entries, modFolders, sourceMods);
    const archived = this.archivesAndStrings(gameRelease)(entries, runtimeOutput.files, reading.modFiles);
    const archiveSources = this.archiveSources(gameRelease, reading.archiveList, reading.dataFolderArchives, archived.index, archived.overwrite);
    told.archiveSources(archiveSources);
    const toRead = this.archivesToRead(archiveSources, plugins, pluginsLoadedWithNoLine, dataFolder);
    const archiveContents = await this.archives.read(gameRelease, toRead.toRead, stampOf);
    told.archiveContents(archiveContents);
    const loaded = this.loaded(archiveSources, toRead.active);
    const loadedArchives = this.loadedArchives(loaded, archiveContents);
    const stackedCopies = this.stack(index, loadedArchives, gameRelease);
    const gameFolderArchived = this.gameFolderArchived(toRead, archiveContents, gameRelease);
    const flaggedHashes = await this.flagged.read(gameRelease, await trustingKept(() => flaggedPluginsIn(reading.holdsRepository ? entries.flatMap((entry) => {
      const folder = entry.kind === 'mod' ? modFolders?.holding(entry)?.path : undefined;
      return folder === undefined ? [] : [{ folder, files: index.filesByMod.get(entry.name) ?? [] }];
    }) : [], (path) => this.adapter.ownPath(path))), stampOf);
    const snapshot = this.snapshot(plugins, gameFolder, pluginsLoadedWithNoLine, modFolders, entries, paths, archiveSources);
    return {
      mods: entries,
      modGroups: reading.modGroups,
      modFolders: modFolders?.all,
      modNames: this.modNames(entries, modFolders),
      ...this.sourceMods(entries, paths.sourceDirs),
      holdsRepository: reading.holdsRepository,
      repositorySetUp: reading.repositorySetUp,
      profiles: reading.profiles,
      files: index.files,
      filesByMod: index.filesByMod,
      foldersByMod: index.foldersByMod,
      archiveContents,
      flaggedHashes,
      loadsArchive: this.loadsArchive(loaded),
      stackedCopies,
      gameFolderArchived,
      gameFolderInWorkspace: dataFolder !== undefined,
      papyrusScripts: this.papyrusScripts(
        this.scripts(gameRelease)(entries, runtimeOutput.files, reading.modFiles).index.files, reading.dataFolderFiles, gameRelease, loadedArchives, gameFolderArchived,
      ),
      plugins,
      downloadedFiles: this.downloadedFiles(downloadedFiles, this.installedInto(reading.folderMeta), entries, paths.sourceDirs),
      activeProfile: reading.profile,
      managerNames: this.adapter.names,
      managerRunning: reading.managerRunning,
      entryKey: this.entryKey,
      gameName: reading.gameName,
      blueprintLoadsLast: blueprintLoadsLastIn(gameRelease),
      nexusDomainOf: nexusDomainForMetaGame,
      gameFolder,
      programVersions: reading.programVersions,
      gameFolderLinks: reading.gameFolderLinks,
      dataFolderPlugins,
      dataFolderFiles: reading.dataFolderFiles,
      pluginsLoadedWithNoLine,
      loadOrderSnapshot: snapshot === undefined || 'refusal' in snapshot ? snapshot : await this.stamped(snapshot, stampOf),
      overwriteFiles: runtimeOutput.files,
      overwriteFolders: runtimeOutput.folders,
      paths,
      publisherTags: this.adapter.publisherTags,
      publisherConfiguration: reading.publisherConfiguration,
      sortingRuleFiles: reading.sortingRuleFiles,
      unwatchedFolders: reading.unwatchedFolders,
    };
  }
}

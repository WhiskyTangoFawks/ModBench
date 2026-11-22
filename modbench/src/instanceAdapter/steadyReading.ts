// A fact no kept read answers by identity stays the object it was while the values it was read as are the same.

import { asLanded, noneLeft, readAs, sameInputs } from '../ports/lastBuilt';
import type { PluginEntry } from '../loadOrderFileCodec/pluginsText';
import type {
  DataFolderArchives, DataFolderFiles, DataFolderPlugins, DataFolderUnlisted, DownloadedFiles, GameFolder, ManagerRunning, ModFolder, ModFolders, ModlistEntry, ModMeta, OriginFile, OriginFiles,
  OriginFolder, SortingRuleFile, SortingRuleFiles, UnwatchedFolder,
} from './instanceAdapter';
import type { ProgramVersion, ProgramVersions } from './gameFolder/programVersions';

/** The facts of one reading as read, before they are steadied. */
export interface ReadFacts {
  readonly mods: readonly ModlistEntry[];
  readonly pluginOrder: readonly PluginEntry[];
  readonly gameFolder: GameFolder;
  readonly programVersions: ProgramVersions;
  readonly dataFolderPlugins: DataFolderPlugins;
  readonly creationClubList: readonly string[];
  readonly archiveList: readonly string[];
  readonly dataFolderArchives: DataFolderArchives;
  readonly dataFolderFiles: DataFolderFiles;
  readonly profiles: readonly string[];
  readonly modFolders: ModFolders | undefined;
  readonly downloadedFiles: DownloadedFiles;
  readonly sourceModFolders: ReadonlyMap<string, string>;
  readonly sortingRuleFiles: SortingRuleFiles;
  readonly unwatchedFolders: readonly UnwatchedFolder[];
  readonly managerRunning: ManagerRunning;
  readonly modFiles: ReadonlyMap<string, OriginFiles>;
  readonly runtimeOutput: OriginFiles;
  readonly folderMeta: ReadonlyMap<string, ModMeta>;
}

// Each parts function names every field of its fact; `noneLeft` fails to compile on a field it does not name.

function gameFolderParts(folder: GameFolder): unknown[] {
  if (folder.kind === 'found') {
    const { kind, root, dataFolder, ...rest } = folder;
    return [kind, root, dataFolder, ...noneLeft(rest)];
  }
  const { kind, setting, looked, ...rest } = folder;
  return [kind, setting, ...looked.flatMap(({ place, answer, ...look }) => [place, answer, ...noneLeft(look)]), ...noneLeft(rest)];
}

function programVersionParts(version: ProgramVersion): unknown[] {
  if (version.kind === 'read') {
    const { kind, version: read, ...rest } = version;
    return [kind, read, ...noneLeft(rest)];
  }
  if (version.kind === 'unreadable') {
    const { kind, program, why, ...rest } = version;
    return [kind, program, why, ...noneLeft(rest)];
  }
  const { kind, program, ...rest } = version;
  return [kind, program, ...noneLeft(rest)];
}

function programVersionsParts(versions: ProgramVersions): unknown[] {
  if (versions.kind !== 'found') {
    const { kind, ...rest } = versions;
    return [kind, ...noneLeft(rest)];
  }
  const { kind, game, extender, ...rest } = versions;
  return [kind, ...programVersionParts(game), ...programVersionParts(extender), ...noneLeft(rest)];
}

function unlistedParts(fact: DataFolderUnlisted): unknown[] {
  if (fact.kind === 'unresolved') {
    const { kind, ...rest } = fact;
    return [kind, ...noneLeft(rest)];
  }
  const { kind, reason, ...rest } = fact;
  return [kind, reason, ...noneLeft(rest)];
}

function sortingRuleFileParts(file: SortingRuleFile): unknown[] {
  if (file.kind === 'text') {
    const { path, kind, text, ...rest } = file;
    return [path, kind, text, ...noneLeft(rest)];
  }
  if (file.kind === 'unreadable') {
    const { path, kind, reason, ...rest } = file;
    return [path, kind, reason, ...noneLeft(rest)];
  }
  const { path, kind, ...rest } = file;
  return [path, kind, ...noneLeft(rest)];
}

function downloadedFilesParts(downloaded: DownloadedFiles): unknown[] {
  if (downloaded.kind === 'unresolved') {
    const { kind, reason, ...rest } = downloaded;
    return [kind, reason, ...noneLeft(rest)];
  }
  const { kind, downloadsDir, files, ...rest } = downloaded;
  return [kind, downloadsDir, files === undefined, ...noneLeft(rest), ...(files ?? []).flatMap(({ name, path, metadataPath, size, mtimeMs, excluded, meta, modID, ...file }) => [
    name, path, metadataPath, size, mtimeMs, excluded, meta, modID, ...noneLeft(file),
  ])];
}

function dataFolderFilesParts(files: DataFolderFiles): unknown[] {
  if (files.kind !== 'listed') return unlistedParts(files);
  const { kind, files: listed, ...rest } = files;
  return [kind, ...noneLeft(rest), ...[...listed].flatMap(([key, { relativePath, path, ...file }]) => [key, relativePath, path, ...noneLeft(file)])];
}

function dataFolderPluginsParts(plugins: DataFolderPlugins): unknown[] {
  if (plugins.kind !== 'listed') return unlistedParts(plugins);
  const { kind, names, ...rest } = plugins;
  return [kind, ...noneLeft(rest), ...names];
}

function dataFolderArchivesParts(archives: DataFolderArchives): unknown[] {
  if (archives.kind !== 'listed') return unlistedParts(archives);
  const { kind, archives: listed, stringsFiles, ...rest } = archives;
  return [kind, listed.length, ...listed, ...stringsFiles, ...noneLeft(rest)];
}

const folderMetaParts = (metas: ReadonlyMap<string, ModMeta>): unknown[] => [...metas].flatMap(([name, {
  gameName, version, updateAvailable, nexusId, installationFileName, installedFileKeys, ...rest
}]) => [name, gameName, version, updateAvailable, nexusId, installationFileName, installedFileKeys, ...noneLeft(rest)]);

const modFolderParts = ({ kind, name, path, modName, ...rest }: ModFolder): unknown[] => [kind, name, path, modName, ...noneLeft(rest)];

const unwatchedFolderParts = ({ folder, reason, ...rest }: UnwatchedFolder): unknown[] => [folder, reason, ...noneLeft(rest)];

function managerRunningParts(running: ManagerRunning): unknown[] {
  if (running.kind === 'unknown') {
    const { kind, reason, ...rest } = running;
    return [kind, reason, ...noneLeft(rest)];
  }
  const { kind, ...rest } = running;
  return [kind, ...noneLeft(rest)];
}

const sortingRuleFilesParts = ({ masterlist, prelude, userlist, ...rest }: SortingRuleFiles): unknown[] =>
  [...sortingRuleFileParts(masterlist), ...sortingRuleFileParts(prelude), ...sortingRuleFileParts(userlist), ...noneLeft(rest)];

const folderParts = ({ relativePath, path, includedPath, excluded, ...rest }: OriginFolder): unknown[] => [relativePath, path, includedPath, excluded, ...noneLeft(rest)];

const fileParts = ({ sourcePath, markedExcluded, ...folder }: OriginFile): unknown[] => [sourcePath, markedExcluded, ...folderParts(folder)];

// Its files and folders are compared by identity, once each is steadied.
const originFilesParts = ({ origin, folder, notes, files, folders, ...rest }: OriginFiles): unknown[] =>
  [origin, folder, notes.length, ...notes, files, folders, ...noneLeft(rest)];

const as = <T extends object | undefined>(fact: T, parts: readonly unknown[], landed: T | undefined): T => asLanded(readAs(fact, parts), landed);

// Each item as the one at its path in `landed` while the two read the same, and `landed` while every item is.
function itemsAsLanded<T extends OriginFolder>(items: readonly T[], landed: readonly T[] | undefined, partsOf: (item: T) => unknown[]): readonly T[] {
  const held = new Map((landed ?? []).map((item) => [item.path, item]));
  const steady = items.map((item) => as(item, partsOf(item), held.get(item.path)));
  return landed !== undefined && sameInputs(landed, steady) ? landed : steady;
}

// A walk its stamps covered answers the object it answered, so only a walk made again is compared, and only with what landed.
function filesAsLanded(files: OriginFiles, landed: OriginFiles | undefined): OriginFiles {
  if (landed === files) return landed;
  const steady = { ...files, files: itemsAsLanded(files.files, landed?.files, fileParts), folders: itemsAsLanded(files.folders, landed?.folders, folderParts) };
  return as(steady, originFilesParts(steady), landed);
}

function modFilesAsLanded(modFiles: ReadonlyMap<string, OriginFiles>, landed: ReadonlyMap<string, OriginFiles> | undefined): ReadonlyMap<string, OriginFiles> {
  const steady = new Map<string, OriginFiles>();
  const landedNames = [...landed?.keys() ?? []];
  let same = landed?.size === modFiles.size;
  for (const [name, files] of modFiles) {
    const held = landed?.get(name);
    const kept = filesAsLanded(files, held);
    same &&= kept === held && landedNames[steady.size] === name;
    steady.set(name, kept);
  }
  return same && landed !== undefined ? landed : steady;
}

function modlistEntryParts(entry: ModlistEntry): unknown[] {
  if (entry.kind === 'separator') {
    const { kind, name, enabled, ...rest } = entry;
    return [kind, name, enabled, ...noneLeft(rest)];
  }
  const { kind, name, enabled, gameName, version, updateAvailable, nexusId, installationFileName, installedFileKeys, ...rest } = entry;
  return [kind, name, enabled, gameName, version, updateAvailable, nexusId, installationFileName, installedFileKeys?.length, ...installedFileKeys ?? [], ...noneLeft(rest)];
}

const pluginEntryParts = ({ name, enabled, ...rest }: PluginEntry): unknown[] => [name, enabled, ...noneLeft(rest)];

/** `read`, each of its facts swapped for `landed`'s object where the two read the same, so a fact nothing changed keeps
 *  its identity (ADR-0029). `landed` is the reading the caller's value last landed from. */
export function steadied(read: ReadFacts, landed?: ReadFacts): ReadFacts {
  const was: Partial<ReadFacts> = landed ?? {};
  return {
    mods: as(read.mods, read.mods.flatMap(modlistEntryParts), was.mods),
    pluginOrder: as(read.pluginOrder, read.pluginOrder.flatMap(pluginEntryParts), was.pluginOrder),
    gameFolder: as(read.gameFolder, gameFolderParts(read.gameFolder), was.gameFolder),
    programVersions: as(read.programVersions, programVersionsParts(read.programVersions), was.programVersions),
    dataFolderPlugins: as(read.dataFolderPlugins, dataFolderPluginsParts(read.dataFolderPlugins), was.dataFolderPlugins),
    creationClubList: as(read.creationClubList, read.creationClubList, was.creationClubList),
    archiveList: as(read.archiveList, read.archiveList, was.archiveList),
    dataFolderArchives: as(read.dataFolderArchives, dataFolderArchivesParts(read.dataFolderArchives), was.dataFolderArchives),
    dataFolderFiles: as(read.dataFolderFiles, dataFolderFilesParts(read.dataFolderFiles), was.dataFolderFiles),
    profiles: as(read.profiles, read.profiles, was.profiles),
    modFolders: as(read.modFolders, read.modFolders?.all.flatMap(modFolderParts) ?? [undefined], was.modFolders),
    downloadedFiles: as(read.downloadedFiles, downloadedFilesParts(read.downloadedFiles), was.downloadedFiles),
    sourceModFolders: as(read.sourceModFolders, [...read.sourceModFolders].flat(), was.sourceModFolders),
    sortingRuleFiles: as(read.sortingRuleFiles, sortingRuleFilesParts(read.sortingRuleFiles), was.sortingRuleFiles),
    unwatchedFolders: as(read.unwatchedFolders, read.unwatchedFolders.flatMap(unwatchedFolderParts), was.unwatchedFolders),
    managerRunning: as(read.managerRunning, managerRunningParts(read.managerRunning), was.managerRunning),
    modFiles: modFilesAsLanded(read.modFiles, was.modFiles),
    runtimeOutput: filesAsLanded(read.runtimeOutput, was.runtimeOutput),
    folderMeta: as(read.folderMeta, folderMetaParts(read.folderMeta), was.folderMeta),
  };
}

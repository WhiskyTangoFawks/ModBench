// A fact no kept read answers by identity stays the object it was while the values it was read as are the same.

import { lastHanded, noneLeft } from '../ports/lastBuilt';
import type {
  DataFolderArchives, DataFolderFiles, DataFolderPlugins, DownloadedFiles, GameFolder, ManagerRunning, ModFolder, ModFolders, ModlistEntry, ModMeta, OriginFiles,
  SortingRuleFile, SortingRuleFiles, UnwatchedFolder,
} from './instanceAdapter';
import type { ProgramVersion, ProgramVersions } from './gameFolder/programVersions';

/** The facts of one reading as read, before they are steadied. */
export interface ReadFacts {
  readonly mods: { readonly kept: ModlistEntry[]; readonly notes: string[] };
  /** What `mods` is made of: the mod order file's lines and each listed mod's meta, as their kept reads answer them. */
  readonly modsReadFrom: readonly unknown[];
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
  readonly folderMeta: ReadonlyMap<string, ModMeta>;
}

export type SteadyFacts = Omit<ReadFacts, 'modsReadFrom'>;

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
  if (versions.kind !== 'found') return [versions.kind];
  const { kind, game, extender, ...rest } = versions;
  return [kind, ...programVersionParts(game), ...programVersionParts(extender), ...noneLeft(rest)];
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
  if (files.kind === 'unresolved') return [files.kind];
  if (files.kind === 'unreadable') return [files.kind, files.reason];
  return [files.kind, ...[...files.files].flatMap(([key, { relativePath, path, ...rest }]) => [key, relativePath, path, ...noneLeft(rest)])];
}

function dataFolderPluginsParts(plugins: DataFolderPlugins): unknown[] {
  if (plugins.kind === 'unresolved') return [plugins.kind];
  return plugins.kind === 'unreadable' ? [plugins.kind, plugins.reason] : [plugins.kind, ...plugins.names];
}

function dataFolderArchivesParts(archives: DataFolderArchives): unknown[] {
  if (archives.kind === 'unresolved') return [archives.kind];
  if (archives.kind === 'unreadable') return [archives.kind, archives.reason];
  const { kind, archives: listed, stringsFiles, ...rest } = archives;
  return [kind, listed.length, ...listed, ...stringsFiles, ...noneLeft(rest)];
}

const folderMetaParts = (metas: ReadonlyMap<string, ModMeta>): unknown[] => [...metas].flatMap(([name, {
  gameName, version, updateAvailable, nexusId, installationFileName, installedFileKeys, ...rest
}]) => [name, gameName, version, updateAvailable, nexusId, installationFileName, installedFileKeys, ...noneLeft(rest)]);

const modFolderParts = ({ kind, name, path, modName, ...rest }: ModFolder): unknown[] => [kind, name, path, modName, ...noneLeft(rest)];

const unwatchedFolderParts = ({ folder, reason, ...rest }: UnwatchedFolder): unknown[] => [folder, reason, ...noneLeft(rest)];

const managerRunningParts = (running: ManagerRunning): unknown[] => (running.kind === 'unknown' ? [running.kind, running.reason] : [running.kind]);

/** Steadies each reading of one source against the one before it. */
export function readingSteadier(): (read: ReadFacts) => SteadyFacts {
  const steady = {
    mods: lastHanded<ReadFacts['mods']>(),
    gameFolder: lastHanded<GameFolder>(),
    programVersions: lastHanded<ProgramVersions>(),
    dataFolderPlugins: lastHanded<DataFolderPlugins>(),
    creationClubList: lastHanded<readonly string[]>(),
    archiveList: lastHanded<readonly string[]>(),
    dataFolderArchives: lastHanded<DataFolderArchives>(),
    dataFolderFiles: lastHanded<DataFolderFiles>(),
    profiles: lastHanded<readonly string[]>(),
    modFolders: lastHanded<ModFolders | undefined>(),
    downloadedFiles: lastHanded<DownloadedFiles>(),
    sourceModFolders: lastHanded<ReadonlyMap<string, string>>(),
    sortingRuleFiles: lastHanded<SortingRuleFiles>(),
    unwatchedFolders: lastHanded<readonly UnwatchedFolder[]>(),
    managerRunning: lastHanded<ManagerRunning>(),
    modFiles: lastHanded<ReadonlyMap<string, OriginFiles>>(),
    folderMeta: lastHanded<ReadonlyMap<string, ModMeta>>(),
  };
  return (read) => {
    const { sortingRuleFiles: rules, managerRunning } = read;
    return {
      mods: steady.mods(read.mods, read.modsReadFrom),
      gameFolder: steady.gameFolder(read.gameFolder, gameFolderParts(read.gameFolder)),
      programVersions: steady.programVersions(read.programVersions, programVersionsParts(read.programVersions)),
      dataFolderPlugins: steady.dataFolderPlugins(read.dataFolderPlugins, dataFolderPluginsParts(read.dataFolderPlugins)),
      creationClubList: steady.creationClubList(read.creationClubList, read.creationClubList),
      archiveList: steady.archiveList(read.archiveList, read.archiveList),
      dataFolderArchives: steady.dataFolderArchives(read.dataFolderArchives, dataFolderArchivesParts(read.dataFolderArchives)),
      dataFolderFiles: steady.dataFolderFiles(read.dataFolderFiles, dataFolderFilesParts(read.dataFolderFiles)),
      profiles: steady.profiles(read.profiles, read.profiles),
      modFolders: steady.modFolders(read.modFolders, read.modFolders?.all.flatMap(modFolderParts) ?? [undefined]),
      downloadedFiles: steady.downloadedFiles(read.downloadedFiles, downloadedFilesParts(read.downloadedFiles)),
      sourceModFolders: steady.sourceModFolders(read.sourceModFolders, [...read.sourceModFolders].flat()),
      sortingRuleFiles: steady.sortingRuleFiles(rules, [rules.masterlist, rules.prelude, rules.userlist].flatMap(sortingRuleFileParts)),
      unwatchedFolders: steady.unwatchedFolders(read.unwatchedFolders, read.unwatchedFolders.flatMap(unwatchedFolderParts)),
      managerRunning: steady.managerRunning(managerRunning, managerRunningParts(managerRunning)),
      modFiles: steady.modFiles(read.modFiles, [...read.modFiles].flatMap(([name, listing]) => [name, listing.folder === undefined ? undefined : listing])),
      folderMeta: steady.folderMeta(read.folderMeta, folderMetaParts(read.folderMeta)),
    };
  };
}

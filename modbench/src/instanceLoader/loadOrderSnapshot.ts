// ADR-0013's snapshot. A plugins.txt line no mod provides names the Data folder's plugin.

import {
  foldPath, isRootLevel, type FileConflictIndex, type FileWinners,
} from './fileConflictIndex';
import {
  fileInFolder, isPluginFile, OVERWRITE_ORIGIN, type DataFolderArchives, type DataFolderPlugins, type FileRead, type FileStamp, type GameFolder,
  type ModFolders, type OriginFile, type PluginEntry,
} from '../instanceAdapter/instanceAdapter';
import { findPluginsOutsideLoadOrder } from './pluginsOutsideLoadOrder';
import { dataFolderFile, pluginCompanionRule } from '../tables/gamePaths';
import type { InstanceValue } from './instance';
import { DATA_DIRECTORY_ORIGIN, exactPluginAddressKey, type PluginAddress, type StampedFile } from '../wire/pluginAddress';

export { OVERWRITE_ORIGIN };
export type { DataFolderPlugins } from '../instanceAdapter/instanceAdapter';

export { DATA_DIRECTORY_ORIGIN };

/** One plugin file in the snapshot — the boundary object (CONTEXT.md): a plugin file
 *  at a physical path, the origin that provides it, and the three registration facts. */
export interface LoadOrderPlugin {
  name: string;
  path: string;
  /** The mod folder that provided this plugin, or a reserved origin value above (ADR-0012). */
  origin: string;
  /** The name's plugins.txt line index, or null when no line names it. An overridden plugin of a
   *  listed name carries the same line as the winning one. */
  line: number | null;
  /** The line's `*` prefix; false when no line names the file. */
  enabled: boolean;
  /** This plugin is the one the Mod override order resolves the name to — overwrite/ first, then
   *  the winning enabled mod. */
  winning: boolean;
}

type SnapshotProvider = { kind: 'Mod'; mod: string; folder: string; sourceFolder?: string } | { kind: 'Game' } | { kind: 'None' };

interface StringsBeside {
  readonly archives: StampedFile[];
  readonly stringsFiles: StampedFile[];
}

// `lineNamesIt`: the line names this copy of its filename, for Editing's judgements (ADR-0013).
type SnapshotPlugin = Pick<LoadOrderPlugin, 'name' | 'path' | 'origin' | 'line'> & StringsBeside & { provider: SnapshotProvider; lineNamesIt: boolean };

/** The snapshot was not built, and why: the user is told once (common.md, Reporting). */
export interface LoadOrderSnapshotRefusal {
  readonly refusal: string;
}

/** ADR-0013's snapshot. */
export interface LoadOrderSnapshotValue {
  readonly dataFolder: string;
  readonly plugins: SnapshotPlugin[];
  readonly active: PluginAddress[];
  readonly loadedWithNoLine: PluginAddress[];
  /** In the order the game loads them, each at the path that wins. */
  readonly archives: StampedFile[];
  /** The loose strings files the game reads, each at the path that wins. */
  readonly stringsFiles: StampedFile[];
}

/** What the snapshot's archives and strings files are resolved from. */
export interface ArchiveSources {
  readonly gameRelease: string | undefined;
  /** The archives the game's INIs list, by name. */
  readonly listed: readonly string[];
  readonly inData: DataFolderArchives;
  readonly files: FileWinners;
  /** Each mod's own files, a disabled mod's too, and Overwrite's, by origin. */
  readonly filesByOrigin: ReadonlyMap<string, readonly OriginFile[]>;
  /** Each archive and strings file, by the path it is read from. */
  readonly stamps: ReadonlyMap<string, FileRead<FileStamp>>;
}

/** A plugins.txt line with no resolvable plugin file: no mod or overwrite/ provides it, and
 *  there is no Data/ to fall back to. Existence, line and enabled still come from plugins.txt. */
export interface LoadOrderPluginLine extends Omit<LoadOrderPlugin, 'path'> {
  readonly path: undefined;
}

/** The files inside a mod's source folder, by the relative path a source tree names them with. */
export interface SourceFiles {
  file(relativePath: string): string;
}

/** `sourceFiles` bound to one generation of the value, for a caller that holds no value of its
 *  own. */
export type SourceFilesOf = (origin: string) => SourceFiles | undefined;

export const NO_SOURCE_FILES: SourceFilesOf = () => undefined;

/** The files of the source folder the Instance adapter answered for the origin's mod (ADR-0007).
 *  `undefined` for Overwrite and the game folder, which are no mod (ADR-0012). */
export function sourceFiles(value: Pick<InstanceValue, 'paths'>, origin: string): SourceFiles | undefined {
  const folder = byOrigin(origin, { overwrite: undefined, data: undefined, mod: (name) => value.paths.sourceDirs.get(name) });
  return folder === undefined ? undefined : { file: (relativePath) => fileInFolder(folder, relativePath) };
}

// Overwrite and the game folder are reserved origins, never mods (ADR-0012).
function byOrigin<T>(origin: string, answers: { overwrite: T; data: T; mod: (name: string) => T }): T {
  if (origin === OVERWRITE_ORIGIN) return answers.overwrite;
  if (origin === DATA_DIRECTORY_ORIGIN) return answers.data;
  return answers.mod(origin);
}

/** The plugin files the mods and overwrite/ provide, keyed case-folded to the winning file's own
 *  name: the Mod override order's answer. A Data-folder plugin is presence, not provision. */
export function providedPluginsOf(files: FileWinners): Map<string, string> {
  const names = [...files].map((file) => file.relativePath).filter((name) => isRootLevel(name) && isPluginFile(name));
  return new Map(names.map((name) => [foldPath(name), name]));
}

/** The plugins the game loads with no line (ADR-0013), in load order: its masters,
 *  then its Creation Club plugins, each from the mod providing it, else the game folder, at its
 *  file's own spelling. */
export function pluginsLoadedWithNoLineOf(
  gameMasters: readonly string[], creationClub: readonly string[], inData: DataFolderPlugins,
  plugins: readonly (LoadOrderPlugin | LoadOrderPluginLine)[],
): PluginAddress[] | undefined {
  if (inData.kind !== 'listed') return undefined;
  const providedBy = new Map(plugins.filter((p) => p.path !== undefined && p.winning && p.origin !== DATA_DIRECTORY_ORIGIN).map((p) => [foldPath(p.name), p] as const));
  const seen = new Set<string>();
  return [...gameMasters, ...creationClub].flatMap((name) => {
    const provided = providedBy.get(foldPath(name));
    const found = provided === undefined ? dataSpellings(inData, name).map((spelled) => ({ name: spelled, origin: DATA_DIRECTORY_ORIGIN })) : [provided];
    return found.flatMap(({ name: spelled, origin }) => {
      const key = exactPluginAddressKey({ name: spelled, origin });
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ name: spelled, origin }];
    });
  });
}

// The game joins a name to its file without regard to case, so a name finds every Data folder
// file that differs from it only in case.
const dataSpellings = (inData: DataFolderPlugins, name: string): string[] =>
  inData.kind === 'listed' ? [...inData.names].filter((spelled) => foldPath(spelled) === foldPath(name)) : [];

type PluginFile = Pick<LoadOrderPlugin, 'name' | 'path' | 'origin'>;

// The plugin each name resolves to by the Mod override order, at its file's own spelling: a line's
// spelling is not authoritative (ADR-0012).
function winningPlugins(files: FileWinners): Map<string, PluginFile> {
  const winners = [...files].filter((entry) => isRootLevel(entry.relativePath)).map((entry) => ({
    name: entry.relativePath,
    path: entry.winner,
    origin: entry.winnerOrigin.kind === 'mod' ? entry.winnerOrigin.name : OVERWRITE_ORIGIN,
  }));
  return new Map(winners.map((winner) => [foldPath(winner.name), winner]));
}

/** A disabled plugins.txt line is still sent (ADR-0013), `enabled: false`. A listed
 *  name no mod or overwrite/ provides takes the Data folder's file, or is line-only with no game
 *  folder found. */
export function buildLoadOrderRows(
  pluginOrder: readonly PluginEntry[],
  index: FileConflictIndex,
  runtimeOutput: readonly OriginFile[],
  gameFolder: GameFolder,
  inData: DataFolderPlugins,
): (LoadOrderPlugin | LoadOrderPluginLine)[] {
  const winners = winningPlugins(index.files);
  // The game matches a line to a file without case, so a case difference must not read as
  // "disabled".
  const enabledNames = new Set(pluginOrder.filter((line) => line.enabled).map((line) => foldPath(line.name)));
  const lineByName = new Map<string, number>();
  pluginOrder.forEach(({ name }, line) => lineByName.set(foldPath(name), line));

  const listed = pluginOrder.flatMap(({ name }, line) => {
    const folded = foldPath(name);
    const provided = winners.get(folded);
    // The line finds its file without case; the row takes the file's spelling and path. A line
    // spelled as one of two files that differ only in case is the one it names.
    const spellings = dataSpellings(inData, name).sort((a, b) => Number(b === name) - Number(a === name));
    const plugins = provided !== undefined ? [provided] : spellings.length > 0
      ? spellings.map((spelled) => ({ name: spelled, path: dataFolderFile(gameFolder, spelled), origin: DATA_DIRECTORY_ORIGIN }))
      : [{ name, path: dataFolderFile(gameFolder, name), origin: DATA_DIRECTORY_ORIGIN }];
    return plugins.map((plugin, i) => ({ ...plugin, line, enabled: enabledNames.has(folded), winning: i === 0 }));
  });

  const isWinning = ({ name, origin }: PluginFile) => {
    const winner = winners.get(foldPath(name));
    return winner?.name === name && winner.origin === origin;
  };
  const overwriteFiles = runtimeOutput.filter((file) => !file.excluded);
  const outside = findPluginsOutsideLoadOrder([...index.filesByMod, [OVERWRITE_ORIGIN, overwriteFiles]], listed)
    .map((plugin) => ({
      ...plugin,
      line: lineByName.get(foldPath(plugin.name)) ?? null,
      enabled: enabledNames.has(foldPath(plugin.name)),
      winning: isWinning(plugin),
    }));

  return [...listed, ...outside];
}

const byFoldedPath = (a: { readonly relativePath: string }, b: { readonly relativePath: string }): number =>
  (foldPath(a.relativePath) < foldPath(b.relativePath) ? -1 : 1);

// Each file by its folded path in the Data folder: the Mod override order's winner, else the game folder's.
function winningFiles(
  dataFolder: string, inData: readonly string[], files: FileWinners, isOne: (relativePath: string) => boolean,
): Map<string, { readonly relativePath: string; readonly path: string }> {
  const winning = new Map(inData.map((relativePath) => [foldPath(relativePath), { relativePath, path: fileInFolder(dataFolder, relativePath) }]));
  for (const { relativePath, winner } of files) if (isOne(relativePath)) winning.set(foldPath(relativePath), { relativePath, path: winner });
  return winning;
}

// The INIs' archives load first, then each plugin's as the plugin loads. A later archive's file
// replaces an earlier one's, and loose files replace every archive's.
function archivesAndStringsOf(
  { gameRelease, listed, inData, files, stamps }: ArchiveSources, dataFolder: string, active: readonly PluginAddress[],
): Pick<LoadOrderSnapshotValue, 'archives' | 'stringsFiles'> {
  const rule = pluginCompanionRule(gameRelease);
  if (rule === undefined || inData.kind !== 'listed') return { archives: [], stringsFiles: [] };
  const archives = winningFiles(dataFolder, inData.archives, files, rule.isArchive);
  const pluginArchives = active.flatMap(({ name }) =>
    [...archives.values()].filter((archive) => rule.isArchiveOf(name, archive.relativePath)).sort(byFoldedPath));
  const loaded = [...listed.flatMap((name) => archives.get(foldPath(name)) ?? []), ...pluginArchives].map(({ path }) => path);
  const strings = winningFiles(dataFolder, inData.stringsFiles, files, rule.isStringsFile);
  return {
    archives: [...new Set(loaded)].map((path) => stampedIn(stamps, path)),
    stringsFiles: [...strings.values()].map(({ path }) => stampedIn(stamps, path)),
  };
}

// Equal while the file's content is (ADR-0003); a file the reading could not stamp, by why.
function stampedIn(stamps: ArchiveSources['stamps'], path: string): StampedFile {
  const read = stamps.get(path);
  if (read === undefined) return { path, stamp: 'not stamped' };
  if (read.kind === 'unreadable') return { path, stamp: read.reason };
  const { size, modifiedNs, changedNs } = read.answer;
  return { path, stamp: `${size}/${modifiedNs}/${changedNs}` };
}

function stringsBeside(
  { gameRelease, inData, filesByOrigin, stamps }: ArchiveSources, dataFolder: string, { name, origin }: PluginAddress,
): StringsBeside {
  const rule = pluginCompanionRule(gameRelease);
  if (rule === undefined) return { archives: [], stringsFiles: [] };
  const inGameFolder = inData.kind === 'listed' ? [...inData.archives, ...inData.stringsFiles] : [];
  const files = origin === DATA_DIRECTORY_ORIGIN
    ? inGameFolder.map((relativePath) => ({ relativePath, path: fileInFolder(dataFolder, relativePath) }))
    : (filesByOrigin.get(origin) ?? []).filter((file) => !file.excluded).map(({ relativePath, sourcePath }) => ({ relativePath, path: sourcePath }));
  return {
    archives: files.filter(({ relativePath }) => rule.isArchive(relativePath) && rule.isArchiveOf(name, relativePath)).sort(byFoldedPath)
      .map(({ path }) => stampedIn(stamps, path)),
    stringsFiles: files.filter(({ relativePath }) => rule.isStringsFileOf(name, relativePath)).map(({ path }) => stampedIn(stamps, path)),
  };
}

/** The archives the INIs list that no mod, no Overwrite and no game folder holds: the game loads none
 *  of them either. */
export function listedArchivesNothingHolds({ gameRelease, listed, inData, files }: ArchiveSources): string[] {
  const rule = pluginCompanionRule(gameRelease);
  if (rule === undefined || inData.kind !== 'listed') return [];
  const held = new Set([...inData.archives, ...[...files].map(({ relativePath }) => relativePath).filter(rule.isArchive)].map(foldPath));
  return listed.filter((name) => !held.has(foldPath(name)));
}

/** ADR-0013's snapshot: none without a listable game folder, a refusal while a mod's plugin has no mod
 *  folder. Active: the plugins the game loads with no line, then each enabled line's winner. */
export function loadOrderSnapshotOf(value: {
  readonly plugins: readonly (LoadOrderPlugin | LoadOrderPluginLine)[];
  readonly gameFolder: GameFolder;
  readonly pluginsLoadedWithNoLine: readonly PluginAddress[] | undefined;
  readonly modFolders: ModFolders | undefined;
  /** Each source mod's source folder, by mod name. */
  readonly sourceDirs: ReadonlyMap<string, string>;
  readonly archives: ArchiveSources;
}): LoadOrderSnapshotValue | LoadOrderSnapshotRefusal | undefined {
  // Without the game's masters or its archives the snapshot would be silently wrong (principles.md), so
  // the index keeps what it holds until the folder can be read (common.md, States, story 5).
  if (value.gameFolder.kind !== 'found' || value.pluginsLoadedWithNoLine === undefined || value.archives.inData.kind !== 'listed') {
    return undefined;
  }
  const { dataFolder } = value.gameFolder;
  // The filter states a found game folder's own guarantee, never an unchecked cast.
  const rows = value.plugins.filter((p): p is LoadOrderPlugin => p.path !== undefined);
  const rowAt = new Map(rows.map((p) => [exactPluginAddressKey(p), p] as const));
  const whatProvides = (origin: string) => byOrigin<SnapshotProvider | undefined>(origin, {
    overwrite: { kind: 'None' },
    data: { kind: 'Game' },
    mod: (name) => {
      const folder = value.modFolders?.holding({ kind: 'mod', name });
      if (folder === undefined) return undefined;
      const sourceFolder = value.sourceDirs.get(name);
      return sourceFolder === undefined ? { kind: 'Mod', mod: name, folder: folder.path } : { kind: 'Mod', mod: name, folder: folder.path, sourceFolder };
    },
  });
  const loadedWithNoLine = value.pluginsLoadedWithNoLine.map((p) =>
    rowAt.get(exactPluginAddressKey(p)) ?? { ...p, path: fileInFolder(dataFolder, p.name), line: null, winning: true });
  const placed = new Set(loadedWithNoLine.map((p) => foldPath(p.name)));
  const fromLines = rows
    .filter((p): p is LoadOrderPlugin & { line: number } => p.line !== null && p.enabled && p.winning)
    .sort((a, b) => a.line - b.line)
    .filter((p) => {
      const folded = foldPath(p.name);
      if (placed.has(folded)) return false;
      placed.add(folded);
      return true;
    });
  const sent = new Map<string, SnapshotPlugin>();
  const unprovided = new Map<string, string[]>();
  for (const { name, path, origin, line, winning } of [...loadedWithNoLine, ...rows]) {
    const provider = whatProvides(origin);
    if (provider === undefined) {
      unprovided.set(origin, [...unprovided.get(origin) ?? [], name]);
      continue;
    }
    const key = exactPluginAddressKey({ name, origin });
    if (!sent.has(key)) {
      sent.set(key, { name, path, origin, provider, line, lineNamesIt: line !== null && winning, ...stringsBeside(value.archives, dataFolder, { name, origin }) });
    }
  }
  if (unprovided.size > 0) return { refusal: refusalOf(unprovided) };
  const active = [...loadedWithNoLine, ...fromLines].map(({ name, origin }) => ({ name, origin }));
  return {
    dataFolder,
    plugins: [...sent.values()],
    active,
    loadedWithNoLine: loadedWithNoLine.map(({ name, origin }) => ({ name, origin })),
    ...archivesAndStringsOf(value.archives, dataFolder, active),
  };
}

const listed = (names: readonly string[]): string =>
  names.length < 3 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

const refusalOf = (unprovided: ReadonlyMap<string, readonly string[]>): string =>
  [...unprovided].map(([mod, names]) => `${listed(names)} ${names.length === 1 ? 'is' : 'are'} provided by the mod ${mod}, which has no mod folder`).join('; ');

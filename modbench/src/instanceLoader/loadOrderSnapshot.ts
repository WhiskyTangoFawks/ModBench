// ADR-0013's snapshot. A plugins.txt line no mod provides names the Data folder's plugin.

import {
  foldPath, type FileConflictIndex, type FileWinners,
} from './fileConflictIndex';
import {
  dataFolderFile, fileInFolder, type DataFolderArchives, type DataFolderPlugins, type FileRead, type FileStamp, type GameFolder,
  type ModFolders, type OriginFile, type PluginEntry,
} from '../instanceAdapter/instanceAdapter';
import { isRootLevel } from '../tables/pluginFile';
import { modOfOrigin } from './modOfOrigin';
import { pluginOrderOf } from './pluginOrder';
import { findPluginsOutsideLoadOrder } from './pluginsOutsideLoadOrder';
import { pluginCompanionRule } from '../tables/gamePaths';
import type { InstanceValue } from './instance';
import { DATA_DIRECTORY_ORIGIN, OVERWRITE_ORIGIN, exactPluginAddressKey, pluginNameKey, type PluginAddress, type PluginPlace, type StampedFile } from '../wire/pluginAddress';

export type { DataFolderPlugins } from '../instanceAdapter/instanceAdapter';

/** One plugin file in the snapshot — the boundary object (GLOSSARY.md): a plugin file
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

// A file is a path until the snapshot is stamped.
interface StringsBeside<F> {
  readonly archives: F[];
  readonly stringsFiles: F[];
}

// `lineNamesIt`: the line names this copy of its filename, for Editing's judgements (ADR-0013).
type SnapshotPlugin<F> = Pick<LoadOrderPlugin, 'name' | 'path' | 'origin' | 'line'> & StringsBeside<F> & { provider: SnapshotProvider; lineNamesIt: boolean };

/** The snapshot was not built, and why: the user is told once (common.md, Reporting). */
export interface LoadOrderSnapshotRefusal {
  readonly refusal: string;
}

/** ADR-0013's snapshot. */
export interface LoadOrderSnapshotValue<F = StampedFile> {
  readonly dataFolder: string;
  /** The release of the reading the snapshot was built from. */
  readonly gameRelease: string;
  readonly plugins: SnapshotPlugin<F>[];
  readonly active: PluginAddress[];
  readonly loadedWithNoLine: PluginAddress[];
  /** In the order the game loads them, each at the path that wins. */
  readonly archives: F[];
  /** The loose strings files the game reads, each at the path that wins. */
  readonly stringsFiles: F[];
  /** Each enabled mod that has a mod folder, then Overwrite: where the plugin create gesture offers to put a plugin. */
  readonly places: PluginPlace[];
}

/** What the snapshot's archives and strings files are resolved from. */
export interface ArchiveSources {
  readonly gameRelease: string;
  /** The archives the game's INIs list, by name. */
  readonly listed: readonly string[];
  readonly inData: DataFolderArchives;
  readonly files: FileWinners;
  /** Each mod's own files, a disabled mod's too, and Overwrite's, by origin. */
  readonly filesByOrigin: ReadonlyMap<string, readonly OriginFile[]>;
}

/** A plugins.txt line with no resolvable plugin file: no mod or overwrite/ provides it, and
 *  the Data folder does not hold it or cannot be listed. Existence, line and enabled still come from plugins.txt. */
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
export function sourceFiles(value: Pick<InstanceValue, 'mods' | 'entryKey' | 'paths'>, origin: string): SourceFiles | undefined {
  const folder = byOrigin(origin, { overwrite: undefined, data: undefined, mod: (name) => value.paths.sourceDirs.get(modOfOrigin(value, name)?.name ?? name) });
  return folder === undefined ? undefined : { file: (relativePath) => fileInFolder(folder, relativePath) };
}

// Overwrite and the game folder are reserved origins, never mods (ADR-0012).
function byOrigin<T>(origin: string, answers: { overwrite: T; data: T; mod: (name: string) => T }): T {
  if (origin === OVERWRITE_ORIGIN) return answers.overwrite;
  if (origin === DATA_DIRECTORY_ORIGIN) return answers.data;
  return answers.mod(origin);
}

export type PluginWithNoLine = PluginAddress & { readonly path: string };

/** The plugins the game loads with no line (ADR-0013), in load order, each from the mod providing
 *  it, else the game folder, at its file's own spelling, with that file's path. */
export function pluginsLoadedWithNoLineOf(
  loadedWithNoLine: readonly string[], inData: DataFolderPlugins,
  plugins: readonly (LoadOrderPlugin | LoadOrderPluginLine)[], gameFolder: GameFolder,
): PluginWithNoLine[] | undefined {
  if (inData.kind !== 'listed' || gameFolder.kind !== 'found') return undefined;
  const providedBy = new Map(plugins.filter((p): p is LoadOrderPlugin => p.path !== undefined && p.winning && p.origin !== DATA_DIRECTORY_ORIGIN).map((p) => [foldPath(p.name), p] as const));
  const seen = new Set<string>();
  return loadedWithNoLine.flatMap((name) => {
    const provided = providedBy.get(foldPath(name));
    const found = provided === undefined
      ? dataSpellings(inData, name).map((spelled) => ({ name: spelled, origin: DATA_DIRECTORY_ORIGIN, path: fileInFolder(gameFolder.dataFolder, spelled) }))
      : [provided];
    return found.flatMap(({ name: spelled, origin, path }) => {
      const key = exactPluginAddressKey({ name: spelled, origin });
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ name: spelled, origin, path }];
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
 *  name no mod or overwrite/ provides takes the Data folder's file, or is line-only when the Data
 *  folder does not hold it. */
export function buildLoadOrderRows(
  pluginOrder: readonly PluginEntry[],
  index: FileConflictIndex,
  runtimeOutput: readonly OriginFile[],
  gameFolder: GameFolder,
  inData: DataFolderPlugins,
): (LoadOrderPlugin | LoadOrderPluginLine)[] {
  const winners = winningPlugins(index.files);
  // The adapter hands each name once, and the game matches a line to a file without case, so a case
  // difference must not read as "disabled".
  const lineByName = new Map(pluginOrder.map(({ name }, line) => [pluginNameKey(name), line] as const));
  const isEnabled = (name: string): boolean => pluginOrder[lineByName.get(pluginNameKey(name)) ?? -1]?.enabled ?? false;

  const listed = pluginOrder.flatMap(({ name }, line) => {
    const folded = foldPath(name);
    const provided = winners.get(folded);
    // The line finds its file without case; the row takes the file's spelling and path. A line
    // spelled as one of two files that differ only in case is the one it names.
    const spellings = dataSpellings(inData, name).sort((a, b) => Number(b === name) - Number(a === name));
    const plugins = provided !== undefined ? [provided] : spellings.length > 0
      ? spellings.map((spelled) => ({ name: spelled, path: dataFolderFile(gameFolder, spelled), origin: DATA_DIRECTORY_ORIGIN }))
      : [{ name, path: undefined, origin: DATA_DIRECTORY_ORIGIN }];
    return plugins.map((plugin, i) => ({ ...plugin, line, enabled: isEnabled(name), winning: i === 0 }));
  });

  const isWinning = ({ name, origin }: PluginFile) => {
    const winner = winners.get(foldPath(name));
    return winner?.name === name && winner.origin === origin;
  };
  const overwriteFiles = runtimeOutput.filter((file) => !file.excluded);
  const outside = findPluginsOutsideLoadOrder([...index.filesByMod, [OVERWRITE_ORIGIN, overwriteFiles]], listed)
    .map((plugin) => ({
      ...plugin,
      line: lineByName.get(pluginNameKey(plugin.name)) ?? null,
      enabled: isEnabled(plugin.name),
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
  { gameRelease, listed, inData, files }: ArchiveSources, dataFolder: string, active: readonly PluginAddress[],
): Pick<LoadOrderSnapshotValue<string>, 'archives' | 'stringsFiles'> {
  const rule = pluginCompanionRule(gameRelease);
  if (rule === undefined || inData.kind !== 'listed') return { archives: [], stringsFiles: [] };
  const archives = winningFiles(dataFolder, inData.archives, files, rule.isArchive);
  const pluginArchives = active.flatMap(({ name }) =>
    [...archives.values()].filter((archive) => rule.isArchiveOf(name, archive.relativePath)).sort(byFoldedPath));
  const loaded = [...listed.flatMap((name) => archives.get(foldPath(name)) ?? []), ...pluginArchives].map(({ path }) => path);
  const strings = winningFiles(dataFolder, inData.stringsFiles, files, rule.isStringsFile);
  return { archives: [...new Set(loaded)], stringsFiles: [...strings.values()].map(({ path }) => path) };
}

function stringsBeside(
  { gameRelease, inData, filesByOrigin }: ArchiveSources, dataFolder: string, { name, origin }: PluginAddress,
): StringsBeside<string> {
  const rule = pluginCompanionRule(gameRelease);
  if (rule === undefined) return { archives: [], stringsFiles: [] };
  const inGameFolder = inData.kind === 'listed' ? [...inData.archives, ...inData.stringsFiles] : [];
  const files = origin === DATA_DIRECTORY_ORIGIN
    ? inGameFolder.map((relativePath) => ({ relativePath, path: fileInFolder(dataFolder, relativePath) }))
    : (filesByOrigin.get(origin) ?? []).filter((file) => !file.excluded).map(({ relativePath, sourcePath }) => ({ relativePath, path: sourcePath }));
  return {
    archives: files.filter(({ relativePath }) => rule.isArchive(relativePath) && rule.isArchiveOf(name, relativePath)).sort(byFoldedPath).map(({ path }) => path),
    stringsFiles: files.filter(({ relativePath }) => rule.isStringsFileOf(name, relativePath)).map(({ path }) => path),
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
  readonly pluginsLoadedWithNoLine: readonly PluginWithNoLine[] | undefined;
  readonly modFolders: ModFolders | undefined;
  /** Each source mod's source folder, by mod name. */
  readonly sourceDirs: ReadonlyMap<string, string>;
  /** Where a new plugin can live (`pluginPlacesOf`). */
  readonly places: readonly PluginPlace[];
  readonly archives: ArchiveSources;
}):LoadOrderSnapshotValue<string> | LoadOrderSnapshotRefusal | undefined {
  // Without the game's masters or its archives the snapshot would be silently wrong (principles.md), so
  // the record index keeps what it holds until the folder can be read (common.md, States, story 5).
  if (value.gameFolder.kind !== 'found' || value.pluginsLoadedWithNoLine === undefined || value.archives.inData.kind !== 'listed') {
    return undefined;
  }
  const { dataFolder } = value.gameFolder;
  // The filter states a found game folder's own guarantee, never an unchecked cast.
  const rows = value.plugins.filter((p): p is LoadOrderPlugin => p.path !== undefined);
  const whatProvides = (origin: string) => byOrigin<SnapshotProvider | undefined>(origin, {
    overwrite: { kind: 'None' },
    data: { kind: 'Game' },
    mod: (name) => {
      const folder = value.modFolders?.holding({ kind: 'mod', name });
      if (folder === undefined) return undefined;
      const sourceFolder = value.sourceDirs.get(folder.name);
      return sourceFolder === undefined ? { kind: 'Mod', mod: name, folder: folder.path } : { kind: 'Mod', mod: name, folder: folder.path, sourceFolder };
    },
  });
  const order = pluginOrderOf(
    { plugins: rows, pluginsLoadedWithNoLine: value.pluginsLoadedWithNoLine },
    (p) => ({ ...p, line: null, enabled: true, winning: true }),
  );
  const { loadedWithNoLine } = order;
  const fromLines = order.fromLines.filter((p) => p.enabled);
  const sent = new Map<string, SnapshotPlugin<string>>();
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
    gameRelease: value.archives.gameRelease,
    plugins: [...sent.values()],
    active,
    loadedWithNoLine: loadedWithNoLine.map(({ name, origin }) => ({ name, origin })),
    ...archivesAndStringsOf(value.archives, dataFolder, active),
    places: [...value.places],
  };
}

// Equal while the file's content is (ADR-0003); a file whose stamp could not be read, by why.
const stampText = (read: FileRead<FileStamp>): string =>
  (read.kind === 'unreadable' ? read.reason : `${read.answer.size}/${read.answer.modifiedNs}/${read.answer.changedNs}`);

/** The snapshot with each archive and strings file it hands stamped at its own path, each path read once, so no file it
 *  hands goes without its stamp. */
export async function stampedSnapshot(
  value: LoadOrderSnapshotValue<string>, stampOf: (path: string) => Promise<FileRead<FileStamp>>,
): Promise<LoadOrderSnapshotValue> {
  const reads = new Map<string, Promise<StampedFile>>();
  const stamped = (paths: readonly string[]): Promise<StampedFile[]> => Promise.all(paths.map((path) => {
    const read = reads.get(path) ?? stampOf(path).then((stamp) => ({ path, stamp: stampText(stamp) }));
    reads.set(path, read);
    return read;
  }));
  const [plugins, archives, stringsFiles] = await Promise.all([
    Promise.all(value.plugins.map(async (plugin) => ({ ...plugin, archives: await stamped(plugin.archives), stringsFiles: await stamped(plugin.stringsFiles) }))),
    stamped(value.archives),
    stamped(value.stringsFiles),
  ]);
  return { ...value, plugins, archives, stringsFiles };
}

const listed = (names: readonly string[]): string =>
  names.length < 3 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

const refusalOf = (unprovided: ReadonlyMap<string, readonly string[]>): string =>
  [...unprovided].map(([mod, names]) => `${listed(names)} ${names.length === 1 ? 'is' : 'are'} provided by the mod ${mod}, which has no mod folder`).join('; ');

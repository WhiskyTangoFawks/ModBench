// ADR-0013's snapshot. A plugins.txt line no mod provides names the Data folder's plugin.

import {
  foldPath, type ConflictEntry, type FileConflictIndex, type FileWinners,
} from './fileConflictIndex';
import {
  dataFolderFile, fileInFolder, type DataFolderArchives, type DataFolderPlugins, type FileRead, type FileStamp, type GameFolder,
  type ModFolders, type OriginFile, type PluginEntry,
} from '../instanceAdapter/instanceAdapter';
import { isPluginAtRoot, isRootLevel } from '../tables/pluginFile';
import { modOfOrigin } from './modOfOrigin';
import { pluginOrderOf } from './pluginOrder';
import { findPluginsOutsideLoadOrder } from './pluginsOutsideLoadOrder';
import { pluginCompanionRule, type PluginCompanionRule } from '../tables/gamePaths';
import type { InstanceValue } from './instance';
import { DATA_DIRECTORY_ORIGIN, OVERWRITE_ORIGIN, exactPluginAddressKey, originAddressOf, pluginNameKey, type PluginAddress, type PluginPlace, type StampedFile } from '../wire/pluginAddress';
import { lastBuilt } from '../ports/lastBuilt';

export type { DataFolderFiles, DataFolderPlugins } from '../instanceAdapter/instanceAdapter';

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
  /** The archives the INIs list, in their order, each at the path that wins. */
  readonly listedArchives: F[];
  /** The archives each active plugin loads with it, each at the path that wins. The game loads them after `listedArchives`, in the order it loads the plugins in. */
  readonly archivesByPlugin: (PluginAddress & { readonly archives: F[] })[];
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

/** The facts `sourceFiles` reads that change. */
export const SOURCE_FILES_READ = { mods: true, paths: true } as const;

/** The files of the source folder the Instance adapter answered for the origin's mod (ADR-0007).
 *  `undefined` for Overwrite and the game folder, which are no mod (ADR-0012). */
export function sourceFiles(value: Pick<InstanceValue, keyof typeof SOURCE_FILES_READ | 'entryKey'>, origin: string): SourceFiles | undefined {
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
    origin: originAddressOf(entry.winnerOrigin),
  }));
  return new Map(winners.map((winner) => [foldPath(winner.name), winner]));
}

type RootFiles = Pick<FileConflictIndex, 'files' | 'filesByMod'>;

interface RootPlugins {
  readonly winners: Map<string, PluginFile>;
  readonly byOrigin: readonly (readonly [string, readonly OriginFile[]])[];
}

// What the index holds at the game's root is read from every file once per index, which a refresh that
// changed no listing reuses whole.
const rootPluginsOfIndex = new WeakMap<RootFiles, RootPlugins>();

function rootPluginsOf(index: RootFiles): RootPlugins {
  const held = rootPluginsOfIndex.get(index);
  if (held !== undefined) return held;
  const read = {
    winners: winningPlugins(index.files),
    byOrigin: [...index.filesByMod].map(([origin, files]) => [origin, files.filter((file) => isPluginAtRoot(file.relativePath))] as const),
  };
  rootPluginsOfIndex.set(index, read);
  return read;
}

/** A disabled plugins.txt line is still sent (ADR-0013), `enabled: false`. A listed
 *  name no mod or overwrite/ provides takes the Data folder's file, or is line-only when the Data
 *  folder does not hold it. */
export function buildLoadOrderRows(
  pluginOrder: readonly PluginEntry[],
  index: RootFiles,
  runtimeOutput: readonly OriginFile[],
  gameFolder: GameFolder,
  inData: DataFolderPlugins,
): (LoadOrderPlugin | LoadOrderPluginLine)[] {
  const { winners, byOrigin } = rootPluginsOf(index);
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
  const outside = findPluginsOutsideLoadOrder([...byOrigin, [OVERWRITE_ORIGIN, overwriteFiles]], listed)
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
function archivesLoaded<A extends { readonly relativePath: string }>(
  rule: PluginCompanionRule, listed: readonly string[], active: readonly PluginAddress[], archives: ReadonlyMap<string, A>,
): { readonly listed: A[]; readonly byPlugin: (PluginAddress & { readonly archives: A[] })[] } {
  return {
    listed: listed.flatMap((name) => archives.get(foldPath(name)) ?? []),
    byPlugin: active.map(({ name, origin }) => ({
      name, origin, archives: [...archives.values()].filter((archive) => rule.isArchiveOf(name, archive.relativePath)).sort(byFoldedPath),
    })),
  };
}

/** The archives `files` holds at the root that the game loads, the INIs listing them or a plugin in `active`, in the order
 *  it loads them. */
export function archivesGameLoads(gameRelease: string, listed: readonly string[], active: readonly PluginAddress[], files: FileWinners): ConflictEntry[] {
  const rule = pluginCompanionRule(gameRelease);
  if (rule === undefined) return [];
  const archives = new Map([...files].filter(({ relativePath }) => rule.isArchive(relativePath)).map((entry) => [foldPath(entry.relativePath), entry] as const));
  const loaded = archivesLoaded(rule, listed, active, archives);
  return [...new Set([...loaded.listed, ...loaded.byPlugin.flatMap((plugin) => plugin.archives)])];
}

// The archives the game loads from the Data folder, a mod's and the game folder's, by the path each is read from.
function loadedFromData({ gameRelease, listed, inData, files }: ArchiveSources, dataFolder: string, active: readonly PluginAddress[]) {
  const rule = pluginCompanionRule(gameRelease);
  if (rule === undefined || inData.kind !== 'listed') return undefined;
  return { rule, inData, loaded: archivesLoaded(rule, listed, active, winningFiles(dataFolder, inData.archives, files, rule.isArchive)) };
}

/** Every archive the game loads from the Data folder, by the path it is read from, in the order it loads them. */
export function archivesInLoadOrder(sources: ArchiveSources, dataFolder: string, active: readonly PluginAddress[]): string[] {
  const held = loadedFromData(sources, dataFolder, active);
  if (held === undefined) return [];
  const { loaded } = held;
  return [...new Set([...loaded.listed, ...loaded.byPlugin.flatMap((plugin) => plugin.archives)].map(({ path }) => path))];
}

function archivesAndStringsOf(
  sources: ArchiveSources, dataFolder: string, active: readonly PluginAddress[],
): Pick<LoadOrderSnapshotValue<string>, 'listedArchives' | 'archivesByPlugin' | 'stringsFiles'> {
  const held = loadedFromData(sources, dataFolder, active);
  if (held === undefined) return { listedArchives: [], archivesByPlugin: [], stringsFiles: [] };
  const { rule, inData, loaded } = held;
  const listedArchives = loaded.listed.map(({ path }) => path);
  const archivesByPlugin = loaded.byPlugin.map(({ name, origin, archives }) => ({ name, origin, archives: archives.map(({ path }) => path) }));
  const strings = winningFiles(dataFolder, inData.stringsFiles, sources.files, rule.isStringsFile);
  return {
    listedArchives, archivesByPlugin,
    stringsFiles: [...strings.values()].map(({ path }) => path),
  };
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
  const held = new Set([...inData.archives.map(foldPath), ...archivesOfFiles(files, gameRelease, rule.isArchive)]);
  return listed.filter((name) => !held.has(foldPath(name)));
}

// The archives the files hold are scanned once per index, which a refresh that changed no listing reuses whole.
const archivesOfIndex = new WeakMap<FileWinners, { readonly gameRelease: string; readonly archives: ReadonlySet<string> }>();

function archivesOfFiles(files: FileWinners, gameRelease: string, isArchive: (relativePath: string) => boolean): ReadonlySet<string> {
  const held = archivesOfIndex.get(files);
  if (held?.gameRelease === gameRelease) return held.archives;
  const archives = new Set([...files].map(({ relativePath }) => relativePath).filter(isArchive).map(foldPath));
  archivesOfIndex.set(files, { gameRelease, archives });
  return archives;
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
  (read.kind === 'unreadable' ? read.reason : `${read.answer.size}/${read.answer.modifiedNs}`);

const pathsToStamp = (value: LoadOrderSnapshotValue<string>): string[] => [...new Set([
  ...value.plugins.flatMap((plugin) => [...plugin.archives, ...plugin.stringsFiles]), ...value.listedArchives,
  ...value.archivesByPlugin.flatMap((plugin) => plugin.archives), ...value.stringsFiles,
])];

function stampedWith(value: LoadOrderSnapshotValue<string>, paths: readonly string[], ...stamps: string[]): LoadOrderSnapshotValue {
  const stampAt = new Map(paths.map((path, at) => [path, stamps[at] ?? '']));
  const stamped = (files: readonly string[]): StampedFile[] => files.map((path) => ({ path, stamp: stampAt.get(path) ?? '' }));
  return {
    ...value,
    plugins: value.plugins.map((plugin) => ({ ...plugin, archives: stamped(plugin.archives), stringsFiles: stamped(plugin.stringsFiles) })),
    listedArchives: stamped(value.listedArchives),
    archivesByPlugin: value.archivesByPlugin.map((plugin) => ({ ...plugin, archives: stamped(plugin.archives) })),
    stringsFiles: stamped(value.stringsFiles),
  };
}

/** Stamps a snapshot's archives and strings files, each path read once, so no file it hands goes without its stamp; it
 *  hands the snapshot it stamped last while that snapshot and every stamp are the same. */
export function snapshotStamper(): (value: LoadOrderSnapshotValue<string>, stampOf: (path: string) => Promise<FileRead<FileStamp>>) => Promise<LoadOrderSnapshotValue> {
  const paths = lastBuilt(pathsToStamp);
  const stamped = lastBuilt(stampedWith);
  return async (value, stampOf) => {
    const toStamp = paths(value);
    return stamped(value, toStamp, ...(await Promise.all(toStamp.map(async (path) => stampText(await stampOf(path))))));
  };
}

const listed = (names: readonly string[]): string =>
  names.length < 3 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

const refusalOf = (unprovided: ReadonlyMap<string, readonly string[]>): string =>
  [...unprovided].map(([mod, names]) => `${listed(names)} ${names.length === 1 ? 'is' : 'are'} provided by the mod ${mod}, which has no mod folder`).join('; ');

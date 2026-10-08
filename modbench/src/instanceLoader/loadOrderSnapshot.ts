// ADR-0013's snapshot. A plugins.txt line no mod provides names the Data folder's plugin.

import {
  foldPath, isRootLevel, type FileConflictIndex, type FileWinners,
} from './fileConflictIndex';
import {
  fileInFolder, isPluginFile, OVERWRITE_ORIGIN, type DataFolderPlugins, type GameFolder, type ModFolders, type OriginFile,
  type PluginEntry,
} from '../instanceAdapter/instanceAdapter';
import { findPluginsOutsideLoadOrder } from './pluginsOutsideLoadOrder';
import { dataFolderFile, dataFolderOf } from '../tables/gamePaths';
import type { InstanceValue } from './instance';
import { DATA_DIRECTORY_ORIGIN, exactPluginAddressKey, type PluginAddress } from '../wire/pluginAddress';

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

type SnapshotProvider = { kind: 'Mod'; mod: string; folder: string } | { kind: 'Game' } | { kind: 'None' };

// `lineNamesIt`: the line names this copy of its filename, for Editing's judgements (ADR-0013).
type SnapshotPlugin = Pick<LoadOrderPlugin, 'name' | 'path' | 'origin' | 'line'> & { provider: SnapshotProvider; lineNamesIt: boolean };

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
}

/** A plugins.txt line with no resolvable plugin file: no mod or overwrite/ provides it, and
 *  there is no Data/ to fall back to. Existence, line and enabled still come from plugins.txt. */
export interface LoadOrderPluginLine extends Omit<LoadOrderPlugin, 'path'> {
  readonly path: undefined;
}

/** The files inside one origin's folder, by the relative path a source tree names them with. */
export interface OriginFiles {
  file(relativePath: string): string;
}

/** `originFiles` bound to one generation of the value, for a caller that holds no value of its
 *  own. */
export type OriginFilesOf = (origin: string) => OriginFiles | undefined;

export const NO_ORIGIN_FILES: OriginFilesOf = () => undefined;

/** The files of the folder the Instance adapter answered for the origin (ADR-0012). `undefined`
 *  when it answered none. */
export function originFiles(value: Pick<InstanceValue, 'paths' | 'gameFolder'>, origin: string): OriginFiles | undefined {
  const folder = originFolder(value, origin);
  return folder === undefined ? undefined : { file: (relativePath) => fileInFolder(folder, relativePath) };
}

function originFolder({ paths, gameFolder }: Pick<InstanceValue, 'paths' | 'gameFolder'>, origin: string): string | undefined {
  return byOrigin(origin, {
    overwrite: paths.overwriteDir, data: dataFolderOf(gameFolder), mod: (name) => paths.modDirs.get(name),
  });
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

/** ADR-0013's snapshot: none without a listable game folder, a refusal while a mod's plugin has no mod
 *  folder. Active: the plugins the game loads with no line, then each enabled line's winner. */
export function loadOrderSnapshotOf(value: {
  readonly plugins: readonly (LoadOrderPlugin | LoadOrderPluginLine)[];
  readonly gameFolder: GameFolder;
  readonly pluginsLoadedWithNoLine: readonly PluginAddress[] | undefined;
  readonly modFolders: ModFolders | undefined;
}): LoadOrderSnapshotValue | LoadOrderSnapshotRefusal | undefined {
  // Without the game's masters the snapshot would be silently wrong (principles.md), so the index
  // keeps what it holds until the folder can be read (common.md, States, story 5).
  if (value.gameFolder.kind !== 'found' || value.pluginsLoadedWithNoLine === undefined) return undefined;
  const { dataFolder } = value.gameFolder;
  // The filter states a found game folder's own guarantee, never an unchecked cast.
  const rows = value.plugins.filter((p): p is LoadOrderPlugin => p.path !== undefined);
  const rowAt = new Map(rows.map((p) => [exactPluginAddressKey(p), p] as const));
  const whatProvides = (origin: string) => byOrigin<SnapshotProvider | undefined>(origin, {
    overwrite: { kind: 'None' },
    data: { kind: 'Game' },
    mod: (name) => {
      const folder = value.modFolders?.holding({ kind: 'mod', name });
      return folder === undefined ? undefined : { kind: 'Mod', mod: name, folder: folder.path };
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
    if (!sent.has(key)) sent.set(key, { name, path, origin, provider, line, lineNamesIt: line !== null && winning });
  }
  if (unprovided.size > 0) return { refusal: refusalOf(unprovided) };
  return {
    dataFolder,
    plugins: [...sent.values()],
    active: [...loadedWithNoLine, ...fromLines].map(({ name, origin }) => ({ name, origin })),
    loadedWithNoLine: loadedWithNoLine.map(({ name, origin }) => ({ name, origin })),
  };
}

const listed = (names: readonly string[]): string =>
  names.length < 3 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

const refusalOf = (unprovided: ReadonlyMap<string, readonly string[]>): string =>
  [...unprovided].map(([mod, names]) => `${listed(names)} ${names.length === 1 ? 'is' : 'are'} provided by the mod ${mod}, which has no mod folder`).join('; ');

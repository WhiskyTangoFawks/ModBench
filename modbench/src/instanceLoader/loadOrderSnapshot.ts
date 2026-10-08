// ADR-0013's snapshot. A plugins.txt line no mod provides names the Data folder's plugin.

import {
  foldPath, isRootLevel, rootLevelWinnerMods, rootLevelWinners, type FileConflictIndex, type FileWinners,
} from './fileConflictIndex';
import {
  fileInFolder, isPluginFile, OVERWRITE_ORIGIN, type DataFolderPlugins, type GameFolder, type ModFolders, type OriginFile,
  type PluginEntry,
} from '../instanceAdapter/instanceAdapter';
import { findPluginsOutsideLoadOrder } from './pluginsOutsideLoadOrder';
import { dataFolderFile, dataFolderOf } from '../tables/gamePaths';
import type { InstanceValue } from './instance';
import { DATA_DIRECTORY_ORIGIN, pluginAddressKey, type PluginAddress } from '../wire/pluginAddress';

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
   *  listed name carries the same slot as the winning one. */
  slot: number | null;
  /** The line's `*` prefix; false when no line names the file. */
  enabled: boolean;
  /** This plugin is the one the Mod override order resolves the name to — overwrite/ first, then
   *  the winning enabled mod. */
  winning: boolean;
}

type SnapshotProvider = { kind: 'Mod'; mod: string; folder: string } | { kind: 'Game' } | { kind: 'None' };

type SnapshotPlugin = Pick<LoadOrderPlugin, 'name' | 'path' | 'origin'> & { provider: SnapshotProvider };

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
 *  there is no Data/ to fall back to. Existence, slot and enabled still come from plugins.txt. */
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
 *  then its Creation Club plugins, each from the mod providing it, else the game folder. */
export function pluginsLoadedWithNoLineOf(
  gameMasters: readonly string[], creationClub: readonly string[], inData: DataFolderPlugins,
  plugins: readonly (LoadOrderPlugin | LoadOrderPluginLine)[],
): PluginAddress[] | undefined {
  if (inData.kind !== 'listed') return undefined;
  const providerOf = new Map(plugins
    .filter((p) => p.path !== undefined && p.winning && p.origin !== DATA_DIRECTORY_ORIGIN)
    .map((p) => [foldPath(p.name), p.origin] as const));
  const seen = new Set<string>();
  return [...gameMasters, ...creationClub].flatMap((name) => {
    const folded = foldPath(name);
    const origin = providerOf.get(folded) ?? (inData.names.has(folded) ? DATA_DIRECTORY_ORIGIN : undefined);
    if (seen.has(folded) || origin === undefined) return [];
    seen.add(folded);
    return [{ name, origin }];
  });
}

// Keyed by lowercased name, since plugins.txt casing is not authoritative.
function resolvePluginPaths(
  names: readonly string[],
  index: FileConflictIndex,
  gameFolder: GameFolder,
): Map<string, string> {
  const winnerByName = rootLevelWinners(index);
  const entries = names
    .map((name): [string, string | undefined] => [name, winnerByName.get(name.toLowerCase()) ?? dataFolderFile(gameFolder, name)])
    .filter((entry): entry is [string, string] => entry[1] !== undefined);
  return new Map(entries);
}

// The files the game wrote at run time win over every mod, so a plugin among them wins path
// resolution too. Only their root holds plugins, and an excluded file provides none.
function overwriteRootFiles(runtimeOutput: readonly OriginFile[]): Map<string, OriginFile> {
  return new Map(runtimeOutput.filter((file) => !file.excluded && isRootLevel(file.relativePath)).map((file) => [foldPath(file.relativePath), file]));
}

/** A disabled plugins.txt line is still sent (ADR-0013), `enabled: false`. A listed
 *  name no mod or overwrite/ provides takes the Data folder's file, or is line-only with no game
 *  folder found. */
export function buildLoadOrderRows(
  pluginOrder: readonly PluginEntry[],
  index: FileConflictIndex,
  runtimeOutput: readonly OriginFile[],
  gameFolder: GameFolder,
): (LoadOrderPlugin | LoadOrderPluginLine)[] {
  const names = pluginOrder.map((line) => line.name);
  const overwriteFiles = overwriteRootFiles(runtimeOutput);
  const pathByName = resolvePluginPaths(names, index, gameFolder);
  const winnerModByName = rootLevelWinnerMods(index);
  // Case-folded, like every other name comparison here: plugins.txt casing is not authoritative,
  // and a case difference must not read as "disabled" or as "a second plugin".
  const enabledNames = new Set(pluginOrder.filter((line) => line.enabled).map((line) => foldPath(line.name)));
  const slotByName = new Map<string, number>();
  names.forEach((name, slot) => slotByName.set(foldPath(name), slot));

  const listed = names.map((name, slot) => {
    const overwriteFile = overwriteFiles.get(foldPath(name));
    const enabledLine = enabledNames.has(foldPath(name));
    if (overwriteFile !== undefined) {
      return { name, path: overwriteFile.sourcePath, origin: OVERWRITE_ORIGIN, slot, enabled: enabledLine, winning: true };
    }
    return {
      name,
      path: pathByName.get(name),
      origin: winnerModByName.get(foldPath(name)) ?? DATA_DIRECTORY_ORIGIN,
      slot,
      enabled: enabledLine,
      winning: true,
    };
  });

  // `winning` is the Mod override order's own answer, independent of listing: an unlisted
  // file's sole provider is still the plugin the name resolves to.
  const isWinning = (plugin: { name: string; origin: string }) =>
    !overwriteFiles.has(foldPath(plugin.name))
    && foldPath(winnerModByName.get(foldPath(plugin.name)) ?? '') === foldPath(plugin.origin);
  const outside = findPluginsOutsideLoadOrder(index, listed.map((p) => ({ name: p.name, origin: p.origin })))
    .map((plugin) => ({
      name: plugin.name,
      path: plugin.path,
      origin: plugin.origin,
      slot: slotByName.get(foldPath(plugin.name)) ?? null,
      enabled: enabledNames.has(foldPath(plugin.name)),
      winning: isWinning(plugin),
    }));

  // overwrite/'s own unlisted plugins — winning-most, but no line names them.
  const strays = [...overwriteFiles]
    .filter(([folded, file]) => !slotByName.has(folded) && isPluginFile(file.relativePath))
    .map(([, file]) => ({
      name: file.relativePath, path: file.sourcePath, origin: OVERWRITE_ORIGIN, slot: null, enabled: false, winning: true,
    }));

  return [...listed, ...outside, ...strays];
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
  const rowAt = new Map(rows.map((p) => [pluginAddressKey(p), p] as const));
  const whatProvides = (origin: string) => byOrigin<SnapshotProvider | undefined>(origin, {
    overwrite: { kind: 'None' },
    data: { kind: 'Game' },
    mod: (name) => {
      const folder = value.modFolders?.holding({ kind: 'mod', name });
      return folder === undefined ? undefined : { kind: 'Mod', mod: name, folder: folder.path };
    },
  });
  const loadedWithNoLine = value.pluginsLoadedWithNoLine.map((p) =>
    rowAt.get(pluginAddressKey(p)) ?? { ...p, path: fileInFolder(dataFolder, p.name) });
  const placed = new Set(loadedWithNoLine.map((p) => foldPath(p.name)));
  const fromLines = rows
    .filter((p): p is LoadOrderPlugin & { slot: number } => p.slot !== null && p.enabled && p.winning)
    .sort((a, b) => a.slot - b.slot)
    .filter((p) => {
      const folded = foldPath(p.name);
      if (placed.has(folded)) return false;
      placed.add(folded);
      return true;
    });
  const sent = new Map<string, SnapshotPlugin>();
  const unprovided = new Map<string, string[]>();
  for (const { name, path, origin } of [...loadedWithNoLine, ...rows]) {
    const provider = whatProvides(origin);
    if (provider === undefined) {
      unprovided.set(origin, [...unprovided.get(origin) ?? [], name]);
      continue;
    }
    const key = pluginAddressKey({ name, origin });
    if (!sent.has(key)) sent.set(key, { name, path, origin, provider });
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

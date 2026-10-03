// ADR-0013's snapshot. A plugins.txt line no mod provides names the Data folder's plugin.

import { basename, dirname, join, sep } from 'node:path';
import { foldPath, rootLevelWinnerMods, rootLevelWinners, type FileConflictIndex } from './fileConflictIndex';
import {
  isPluginFile, OVERWRITE_ORIGIN, type DataFolderPlugins, type GameFolder, type OriginFile, type PluginEntry,
} from '../instanceAdapter/instanceAdapter';
import { findPluginsOutsideLoadOrder } from './pluginsOutsideLoadOrder';
import { dataFolderFile } from '../tables/gamePaths';

export { OVERWRITE_ORIGIN };
export type { DataFolderPlugins } from '../instanceAdapter/instanceAdapter';

// The reserved origin of the game's own Data folder (ADR-0012). Never a real mod folder name: mod
// folders live under `mods/`.
export const DATA_DIRECTORY_ORIGIN = 'Data';

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

/** ADR-0013. */
export type SnapshotPlugin = Pick<LoadOrderPlugin, 'name' | 'path' | 'origin'>;

/** ADR-0013's snapshot. */
export interface LoadOrderSnapshotValue {
  readonly dataFolder: string;
  readonly plugins: SnapshotPlugin[];
  readonly active: Pick<LoadOrderPlugin, 'name' | 'origin'>[];
  readonly loadedWithNoLine: Pick<LoadOrderPlugin, 'name' | 'origin'>[];
}

/** A plugins.txt line with no resolvable plugin file: no mod or overwrite/ provides it, and
 *  there is no Data/ to fall back to. Existence, slot and enabled still come from plugins.txt. */
export interface LoadOrderPluginLine extends Omit<LoadOrderPlugin, 'path'> {
  readonly path: undefined;
}

/** `originFolder` bound to one generation of the value's rows, for a caller that holds no rows
 *  of its own. */
export type OriginFolder = (origin: string) => string | undefined;

/** The folder an origin's plugins sit in, read off the value's own rows, since `overwrite` and
 *  `Data` are not mods (ADR-0012). `undefined` when no row for that origin has a
 *  plugin file on disk. */
export function originFolder(
  plugins: readonly Pick<LoadOrderPlugin | LoadOrderPluginLine, 'origin' | 'path'>[], origin: string,
): string | undefined {
  const plugin = plugins.find((p) => p.path !== undefined && p.origin === origin);
  return plugin?.path === undefined ? undefined : dirname(plugin.path);
}

/** The files inside one origin's folder, by the relative path a source tree names them with. */
export interface OriginFiles {
  file(relativePath: string): string;
  holds(file: string): boolean;
}

/** `originFiles` bound to one generation of the value's rows, for a caller that holds no rows of
 *  its own. */
export type OriginFilesOf = (origin: string) => OriginFiles | undefined;

/** The files of the folder `originFolder` answers, a source tree's relative path joined beneath
 *  it. `undefined` when no row for that origin has a plugin file on disk. */
export function originFiles(
  plugins: readonly Pick<LoadOrderPlugin | LoadOrderPluginLine, 'origin' | 'path'>[], origin: string,
): OriginFiles | undefined {
  const folder = originFolder(plugins, origin);
  if (folder === undefined) return undefined;
  return { file: (relativePath) => join(folder, relativePath), holds: (file) => file.startsWith(folder + sep) };
}

/** The plugin files this instance provides, keyed case-folded to the winning plugin's on-disk
 *  name: the Mod override order's answer, overwrite/ included. A Data-folder plugin is presence,
 *  not provision, and is left out. */
export function providedPluginsOf(
  plugins: readonly Pick<LoadOrderPlugin | LoadOrderPluginLine, 'origin' | 'path' | 'winning'>[],
): Map<string, string> {
  const provided = new Map<string, string>();
  for (const plugin of plugins) {
    if (plugin.path === undefined || !plugin.winning || plugin.origin === DATA_DIRECTORY_ORIGIN) continue;
    const real = basename(plugin.path);
    if (isPluginFile(real)) provided.set(foldPath(real), real);
  }
  return provided;
}

/** ADR-0012. */
export type PluginAddress = Pick<LoadOrderPlugin, 'name' | 'origin'>;

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

/** Keyed by lowercased name, since plugins.txt casing is not authoritative. Root-level index
 *  files only. A name with no mod winner and no game folder found has no entry — nothing to fall
 *  back to. */
export function resolvePluginPaths(
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
// resolution too, not just origin classification. Only their root holds plugins.
function overwriteRootFiles(runtimeOutput: readonly OriginFile[]): Map<string, OriginFile> {
  return new Map(runtimeOutput.filter((file) => !file.relativePath.includes('/')).map((file) => [foldPath(file.relativePath), file]));
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
      return { name, path: overwriteFile.path, origin: OVERWRITE_ORIGIN, slot, enabled: enabledLine, winning: true };
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
      name: file.relativePath, path: file.path, origin: OVERWRITE_ORIGIN, slot: null, enabled: false, winning: true,
    }));

  return [...listed, ...outside, ...strays];
}

/** ADR-0013's snapshot, none without a listable game folder. Active: the plugins the game loads
 *  with no line, then each enabled line's winner. */
export function loadOrderSnapshotOf(value: {
  readonly plugins: readonly (LoadOrderPlugin | LoadOrderPluginLine)[];
  readonly gameFolder: GameFolder;
  readonly pluginsLoadedWithNoLine: readonly PluginAddress[] | undefined;
}): LoadOrderSnapshotValue | undefined {
  // Without the game's masters the snapshot would be silently wrong (principles.md), so the index
  // keeps what it holds until the folder can be read (common.md, States, story 5).
  if (value.gameFolder.kind !== 'found' || value.pluginsLoadedWithNoLine === undefined) return undefined;
  const { dataFolder } = value.gameFolder;
  // The filter states a found game folder's own guarantee, never an unchecked cast.
  const rows = value.plugins.filter((p): p is LoadOrderPlugin => p.path !== undefined);
  const addressOf = (p: PluginAddress) => `${foldPath(p.origin)}\u0000${foldPath(p.name)}`;
  const rowAt = new Map(rows.map((p) => [addressOf(p), p] as const));
  const loadedWithNoLine = value.pluginsLoadedWithNoLine.map((p): SnapshotPlugin =>
    rowAt.get(addressOf(p)) ?? { ...p, path: join(dataFolder, p.name) });
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
  for (const { name, path, origin } of [...loadedWithNoLine, ...rows]) {
    const key = addressOf({ name, origin });
    if (!sent.has(key)) sent.set(key, { name, path, origin });
  }
  return {
    dataFolder,
    plugins: [...sent.values()],
    active: [...loadedWithNoLine, ...fromLines].map(({ name, origin }) => ({ name, origin })),
    loadedWithNoLine: loadedWithNoLine.map(({ name, origin }) => ({ name, origin })),
  };
}

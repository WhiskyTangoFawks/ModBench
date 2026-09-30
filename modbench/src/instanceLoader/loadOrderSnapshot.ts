// Every plugin file the enabled mods and overwrite/ provide, plus the Data-folder plugin of any
// plugins.txt line no mod provides (ADR-0013). Vanilla masters and .ccc content are
// prepended by the backend, never listed here.

import { basename, dirname, join, sep } from 'node:path';
import { foldPath, rootLevelWinnerMods, rootLevelWinners, type FileConflictIndex } from './fileConflictIndex';
import {
  isPluginFile, OVERWRITE_ORIGIN, type GameFolder, type OriginFile, type PluginEntry,
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
  /** The line's `*` prefix (ADR-0013); false when no line names the file. */
  enabled: boolean;
  /** This plugin is the one the Mod override order resolves the name to — overwrite/ first, then
   *  the winning enabled mod. Editing derives participation (`enabled AND winning AND listed`) on
   *  its side; nothing here decides it. */
  winning: boolean;
}

/** A plugins.txt line with no resolvable plugin file: no mod or overwrite/ provides it, and
 *  there is no Data/ to fall back to. Existence, slot and enabled still come from plugins.txt. */
export interface LoadOrderPluginLine extends Omit<LoadOrderPlugin, 'path'> {
  readonly path: undefined;
}

/** `originFolder` bound to one generation of the value's rows, for a caller that holds no rows
 *  of its own. */
export type OriginFolder = (origin: string) => string | undefined;

/** The folder an origin's plugins sit in, read off the value's own rows: `overwrite` and
 *  `Data` are not folders under `mods/` (ADR-0012). `undefined` when no row for that origin
 *  has a plugin file on disk. */
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

/** A disabled plugins.txt line is still sent, `enabled: false` (ADR-0013). A listed name no mod or
 *  overwrite/ provides takes the Data folder's file of that name, or is line-only, `path`
 *  undefined, with no game folder found. */
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

/** ADR-0013's snapshot, read from the current value (ADR-0015) rather than a fresh walk.
 *  `undefined` — no PUT — when the game folder is not found. The filter states a found game
 *  folder's own guarantee, never an unchecked cast. */
export function loadOrderSnapshotOf(value: {
  readonly plugins: readonly (LoadOrderPlugin | LoadOrderPluginLine)[];
  readonly gameFolder: GameFolder;
}): { dataFolder: string; plugins: LoadOrderPlugin[] } | undefined {
  if (value.gameFolder.kind !== 'found') return undefined;
  return {
    dataFolder: value.gameFolder.dataFolder,
    plugins: value.plugins.filter((p): p is LoadOrderPlugin => p.path !== undefined),
  };
}

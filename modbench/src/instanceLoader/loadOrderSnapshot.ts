// Every physical plugin copy the enabled mods and overwrite/ provide, plus the Data-folder copy
// of any plugins.txt line no mod provides (ADR-0013). Vanilla masters and .ccc content are
// prepended by the backend, never listed here.

import { basename, dirname, join } from 'node:path';
import type { ModlistEntry } from '../mo2Codecs/modlistText';
import { buildFileConflictIndex, foldPath, rootLevelWinnerMods, rootLevelWinners, type FileConflictIndex } from './fileConflictIndex';
import { OVERWRITE_DIR_NAME } from '../mo2Codecs/modlistText';
import { overwriteDir } from '../instanceAdapter/layout';
import { isPluginFile } from '../instanceAdapter/pluginFile';
import { findUnlistedPlugins } from './unlistedPlugins';
import { pluginSlots } from '../mo2Codecs/pluginsText';
import { listDir } from '../instanceAdapter/files';
import type { GameFolder } from '../instanceAdapter/gameDirectory';
import { errnoCode } from '../ports/errno';
import { errorMessage } from '../ports/errorMessage';

// Reserved origin values (ADR-0012), matching their literal directory names. Never a real mod
// folder name: mod folders live under `mods/`.
export const DATA_DIRECTORY_ORIGIN = 'Data';
export const OVERWRITE_ORIGIN = OVERWRITE_DIR_NAME;

/** One physical plugin copy in the snapshot — the boundary object (CONTEXT.md): a plugin file
 *  at a physical path, the origin that provides it, and the three registration facts. */
export interface LoadOrderPlugin {
  name: string;
  path: string;
  /** The mod folder that provided this copy, or a reserved origin value above (ADR-0012). */
  origin: string;
  /** The name's plugins.txt line index, or null when no line names it. A losing copy of a listed
   *  name carries the same slot as the winning one. */
  slot: number | null;
  /** The line's `*` prefix (ADR-0013); false when no line names the file. */
  enabled: boolean;
  /** This copy is the one the Mod override order resolves the name to — overwrite/ first, then the
   *  winning enabled mod. Editing derives participation (`enabled AND winning AND listed`) on its
   *  side; nothing here decides it. */
  winning: boolean;
}

/** A plugins.txt line with no resolvable physical copy: no mod or overwrite/ provides it, and
 *  there is no Data/ to fall back to. Existence, slot and enabled still come from plugins.txt. */
export interface LoadOrderPluginLine extends Omit<LoadOrderPlugin, 'path'> {
  readonly path: undefined;
}

/** `originFolder` bound to one generation of the value's rows, for a caller that holds no rows
 *  of its own. */
export type OriginFolder = (origin: string) => string | undefined;

/** The folder an origin's plugin copies sit in, read off the value's own rows: `overwrite` and
 *  `Data` are not folders under `mods/` (ADR-0012). `undefined` when no row for that origin
 *  has a copy on disk. */
export function originFolder(
  plugins: readonly Pick<LoadOrderPlugin | LoadOrderPluginLine, 'origin' | 'path'>[], origin: string,
): string | undefined {
  const copy = plugins.find((p) => p.path !== undefined && p.origin === origin);
  return copy?.path === undefined ? undefined : dirname(copy.path);
}

/** The plugin files this instance provides, keyed case-folded to the winning copy's on-disk
 *  name: the Mod override order's answer, overwrite/ included. A Data-folder copy is presence,
 *  not provision, and is left out. */
export function providedPluginsOf(
  plugins: readonly Pick<LoadOrderPlugin | LoadOrderPluginLine, 'origin' | 'path' | 'winning'>[],
): Map<string, string> {
  const provided = new Map<string, string>();
  for (const copy of plugins) {
    if (copy.path === undefined || !copy.winning || copy.origin === DATA_DIRECTORY_ORIGIN) continue;
    const real = basename(copy.path);
    if (isPluginFile(real)) provided.set(foldPath(real), real);
  }
  return provided;
}

/** Keyed by lowercased name, since plugins.txt casing is not authoritative. Root-level index
 *  files only. A name with no mod winner and no `dataFolder` has no entry — nothing to fall
 *  back to. */
export function resolvePluginPaths(
  names: string[],
  index: FileConflictIndex,
  dataFolder: string | undefined,
): Map<string, string> {
  const winnerByName = rootLevelWinners(index);
  const entries = names
    .map((name): [string, string | undefined] => [name, winnerByName.get(name.toLowerCase()) ?? (dataFolder !== undefined ? join(dataFolder, name) : undefined)])
    .filter((entry): entry is [string, string] => entry[1] !== undefined);
  return new Map(entries);
}

/** What the game's Data folder holds at its root, as a command is handed it. A folder that never
 *  resolved and one that resolved unreadable are different answers: only the second is a run
 *  whose verdicts cannot be trusted. */
export type DataFolderPlugins =
  | { readonly kind: 'listed'; readonly names: ReadonlySet<string> }
  | { readonly kind: 'unresolved' }
  | { readonly kind: 'unreadable'; readonly reason: string };

/** A `.mohidden` file fails the extension test, so MO2's hide-by-rename reads as absent. An
 *  unreadable folder is an answer, never a throw: no MO2 file names it, and the whole value
 *  would otherwise go stale over it. */
export async function readDataFolderPlugins(
  dataFolder: string | undefined, log: (msg: string) => void,
): Promise<DataFolderPlugins> {
  if (dataFolder === undefined) return { kind: 'unresolved' };
  try {
    const dirents = await listDir(dataFolder);
    const names = dirents.filter((d) => d.isFile() && isPluginFile(d.name)).map((d) => foldPath(d.name));
    return { kind: 'listed', names: new Set(names) };
  } catch (err) {
    const reason = errorMessage(err);
    log(`[instance] the game's Data folder could not be listed: ${reason}`);
    return { kind: 'unreadable', reason };
  }
}

// MO2's VFS makes overwrite/ winning-most of all, so a plugin found here wins path resolution
// too, not just origin classification.
async function overwritePluginFiles(instanceRoot: string): Promise<Map<string, string>> {
  try {
    const entries = await listDir(overwriteDir(instanceRoot));
    return new Map(entries.filter((e) => e.isFile()).map((e) => [foldPath(e.name), e.name]));
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return new Map(); // no overwrite folder — nothing wins from it
    throw err;
  }
}

// The three reads a snapshot is built from. The caller reads MO2's files; this module never
// opens one, so a snapshot can only ever be as fresh as the generation it was handed.
type Source = {
  readPluginOrder(): Promise<string[]>;
  readEnabledPlugins(): Promise<string[]>;
  readModlist(): Promise<ModlistEntry[]>;
};
type BuildIndex = (entries: ModlistEntry[], instanceRoot: string) => Promise<FileConflictIndex>;

// Shared by both public entry points below: `dataFolder` optional yields a line-only row
// (`path: undefined`) for a listed name neither a mod nor overwrite/ provides; a definite
// `dataFolder` never does, since `resolvePluginPaths` then covers every name.
async function buildRows(
  source: Source,
  instanceRoot: string,
  dataFolder: string | undefined,
  buildIndex: BuildIndex,
): Promise<(LoadOrderPlugin | LoadOrderPluginLine)[]> {
  const [names, enabled, index, overwriteFiles] = await Promise.all([
    source.readPluginOrder(),
    source.readEnabledPlugins(),
    source.readModlist().then((entries) => buildIndex(entries, instanceRoot)),
    overwritePluginFiles(instanceRoot),
  ]);

  const pathByName = resolvePluginPaths(names, index, dataFolder);
  const winnerModByName = rootLevelWinnerMods(index);
  // Case-folded, like every other name comparison here: plugins.txt casing is not authoritative,
  // and a case difference must not read as "disabled" or as "a second copy".
  const enabledNames = new Set(enabled.map((n) => foldPath(n)));
  const slotByName = new Map<string, number>();
  for (const [name, slot] of pluginSlots(names)) slotByName.set(foldPath(name), slot);

  const listed = names.map((name, slot) => {
    const overwriteFile = overwriteFiles.get(foldPath(name));
    const enabledLine = enabledNames.has(foldPath(name));
    if (overwriteFile !== undefined) {
      return { name, path: join(overwriteDir(instanceRoot), overwriteFile), origin: OVERWRITE_ORIGIN, slot, enabled: enabledLine, winning: true };
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
  // file's sole provider is still the copy the name resolves to.
  const isWinningCopy = (copy: { name: string; origin: string }) =>
    !overwriteFiles.has(foldPath(copy.name))
    && foldPath(winnerModByName.get(foldPath(copy.name)) ?? '') === foldPath(copy.origin);
  const losers = findUnlistedPlugins(index, listed.map((p) => ({ name: p.name, origin: p.origin })))
    .map((copy) => ({
      name: copy.name,
      path: copy.path,
      origin: copy.origin,
      slot: slotByName.get(foldPath(copy.name)) ?? null,
      enabled: enabledNames.has(foldPath(copy.name)),
      winning: isWinningCopy(copy),
    }));

  // overwrite/'s own unlisted plugins — winning-most, but no line names them.
  const strays = [...overwriteFiles]
    .filter(([folded, real]) => !slotByName.has(folded) && isPluginFile(real))
    .map(([, real]) => ({
      name: real, path: join(overwriteDir(instanceRoot), real), origin: OVERWRITE_ORIGIN, slot: null, enabled: false, winning: true,
    }));

  return [...listed, ...losers, ...strays];
}

const defaultBuildIndex: BuildIndex = (entries, root) => buildFileConflictIndex(entries, root, () => {});

/** A disabled plugins.txt line is still sent, `enabled: false` (ADR-0013). A listed name with no
 *  mod or overwrite/ copy still gets a row, its `path` undefined rather than a guess. */
export async function buildLoadOrderRows(
  source: Source,
  instanceRoot: string,
  dataFolder: string | undefined,
  buildIndex: BuildIndex = defaultBuildIndex,
): Promise<(LoadOrderPlugin | LoadOrderPluginLine)[]> {
  return buildRows(source, instanceRoot, dataFolder, buildIndex);
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

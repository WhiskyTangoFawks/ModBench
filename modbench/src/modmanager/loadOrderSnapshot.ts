// Every physical plugin copy the enabled mods and overwrite/ provide, plus the Data-folder copy
// of any plugins.txt line no mod provides (ADR-0013). Vanilla masters and .ccc content are
// prepended by the backend, never listed here.

import { readdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { ModlistEntry } from './model';
import { buildFileConflictIndex, foldPath, rootLevelWinnerMods, rootLevelWinners, type FileConflictIndex } from './fileConflictIndex';
import { OVERWRITE_DIR_NAME, overwriteDir } from './mo2/layout';
import { isPluginFile } from './pluginFile';
import { findUnlistedPlugins } from './unlistedPlugins';
import { pluginSlots } from './mo2/pluginsText';

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

/** The plugin files this instance provides, keyed case-folded to the winning copy's own on-disk
 *  name — the Mod override order's answer, overwrite/ included, read off the value's rows so
 *  that no caller walks mods/ or re-spells the rule (ADR-0015). A Data-folder copy is presence,
 *  not provision, and is left out. */
export function providedPluginsOf(
  plugins: readonly Pick<LoadOrderPlugin | LoadOrderPluginLine, 'name' | 'origin' | 'path' | 'winning'>[],
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

// MO2's VFS makes overwrite/ winning-most of all, so a plugin found here wins path resolution
// too, not just origin classification. Empty until a purge first creates the folder.
async function overwritePluginFiles(instanceRoot: string): Promise<Map<string, string>> {
  try {
    const entries = await readdir(overwriteDir(instanceRoot), { withFileTypes: true });
    return new Map(entries.filter((e) => e.isFile()).map((e) => [foldPath(e.name), e.name]));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Map(); // no overwrite folder — nothing wins from it
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

/** A disabled plugins.txt line is still sent: its missing `*` becomes `enabled: false` rather
 *  than deciding whether the line appears at all (ADR-0013). */
export async function buildLoadOrderSnapshot(
  source: Source,
  instanceRoot: string,
  dataFolder: string,
  // The real caller passes an outputChannel-backed buildIndex, so the walker's surfacing does
  // reach the Output channel; this no-op default only fires for a caller that supplies none.
  buildIndex: BuildIndex = defaultBuildIndex,
): Promise<LoadOrderPlugin[]> {
  const rows = await buildRows(source, instanceRoot, dataFolder, buildIndex);
  // A definite dataFolder means resolvePluginPaths covers every name, so no row here is ever a
  // line-only one — the cast is exact, not a narrowing guess.
  return rows as LoadOrderPlugin[];
}

/** Same rows `buildLoadOrderSnapshot` computes, over the one read `dataFolder` optional: a listed
 *  name with no mod or overwrite/ copy still gets a row (existence, slot, enabled) rather than
 *  being dropped, its `path` undefined instead of a guess. */
export async function buildLoadOrderRows(
  source: Source,
  instanceRoot: string,
  dataFolder: string | undefined,
  buildIndex: BuildIndex = defaultBuildIndex,
): Promise<(LoadOrderPlugin | LoadOrderPluginLine)[]> {
  return buildRows(source, instanceRoot, dataFolder, buildIndex);
}

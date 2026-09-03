// Assembles the load-order snapshot Mod Management sends Editing as `PUT /load-order` (ADR-0044):
// **every physical plugin copy** the instance's enabled mods and overwrite/ provide, plus the
// game's own Data-folder copy of every plugins.txt line no mod provides — each with the three facts
// its registration carries. Plugin *order* (the slot) comes from plugins.txt; which copy of a name
// wins comes from the MO2-priority FileConflictIndex, overwrite/ winning-most of all. Vanilla
// masters are NOT listed here — the backend prepends them from the game directory, forced on and
// immutable, ahead of this list. Creation Club content cataloged in the game's own [Game].ccc gets
// the same forced treatment, also prepended server-side — this module never reads that
// catalog.

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { IModlistSource } from './model';
import { buildFileConflictIndex, foldPath, rootLevelWinnerMods, rootLevelWinners, type FileConflictIndex } from './fileConflictIndex';
import { isPluginFile } from './masterReader';
import { findUnlistedPlugins } from './unlistedPlugins';

// Reserved origin values (ADR-0036): the game's Data directory, and MO2's overwrite
// folder — matching their literal directory names. Never a real mod folder name: mod folders live
// under a different namespace (`mods/`), and "overwrite" is already a reserved MO2 folder name
// elsewhere in this codebase (modlistText.ts's RESERVED_DIR_NAMES).
export const DATA_DIRECTORY_ORIGIN = 'Data';
export const OVERWRITE_ORIGIN = 'overwrite';

/** One physical plugin copy in the snapshot — the boundary object (CONTEXT-MAP.md): a plugin file
 *  at a physical path, the origin that provides it, and the three registration facts. */
export interface LoadOrderPlugin {
  name: string;
  path: string;
  /** The mod folder that provided this copy, or a reserved origin value above (ADR-0036). */
  origin: string;
  /** The name's plugins.txt line index, or null when no line names it. A losing copy of a listed
   *  name carries the same slot as the winning one. */
  slot: number | null;
  /** The line's `*` prefix (ADR-0035); false when no line names the file. */
  enabled: boolean;
  /** This copy is the one the Mod override order resolves the name to — overwrite/ first, then the
   *  winning enabled mod. Editing derives participation (`enabled AND winning AND listed`) on its
   *  side; nothing here decides it. */
  winning: boolean;
}

/** Resolve each plugin name to its winning physical path: the MO2-priority
 *  FileConflictIndex winner for a mod-provided plugin, else the game's Data
 *  folder for a base-game/DLC/CC plugin no mod provides. Keyed by lowercased
 *  name (plugins.txt casing is not authoritative). Only root-level index files
 *  are considered — a nested file sharing a plugin's basename must not shadow
 *  the real plugin. Shared by the snapshot builder and the Plugin List's
 *  order-aware missing-master check. */
export function resolvePluginPaths(
  names: string[],
  index: FileConflictIndex,
  dataFolder: string,
): Map<string, string> {
  const winnerByName = rootLevelWinners(index);
  return new Map(names.map((name) => [name, winnerByName.get(name.toLowerCase()) ?? join(dataFolder, name)]));
}

/** Root-level files directly under the instance's overwrite/ folder, keyed by case-folded name to
 *  their real on-disk name (ADR-0036). MO2's VFS makes overwrite/ winning-most of
 *  all — above every mod and the Data folder — so a plugin found here always wins path resolution
 *  too, not just origin classification. Root-level only, mirroring rootLevelWinners' own reasoning:
 *  a nested file sharing a plugin's basename must not shadow the real plugin. Empty when the
 *  overwrite folder doesn't exist yet — it isn't created until the first purge deposits a stray
 *  file (overwriteFolder.ts). */
async function overwritePluginFiles(instanceRoot: string): Promise<Map<string, string>> {
  try {
    const entries = await readdir(join(instanceRoot, 'overwrite'), { withFileTypes: true });
    return new Map(entries.filter((e) => e.isFile()).map((e) => [foldPath(e.name), e.name]));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Map(); // no overwrite folder — nothing wins from it
    throw err;
  }
}

type Source = Pick<IModlistSource, 'readPluginOrder' | 'readEnabledPlugins' | 'readModlist'>;
type BuildIndex = (
  entries: Awaited<ReturnType<IModlistSource['readModlist']>>,
  instanceRoot: string,
) => Promise<FileConflictIndex>;

/** Builds the snapshot for `PUT /load-order`: the winning copy of every plugins.txt line (disabled
 *  ones included — the `*` prefix becomes `enabled` rather than deciding whether it is sent,
 *  ADR-0035), then every other root-level plugin copy an enabled mod or overwrite/ provides — a
 *  losing copy of a listed name at that name's slot, an unlisted file with no slot — as
 *  `winning: false` unless it is the one the Mod override order would pick. Sole callers are the
 *  load-order sync and "enter editing" in extension.ts. */
export async function buildLoadOrderSnapshot(
  source: Source,
  instanceRoot: string,
  dataFolder: string,
  // buildFileConflictIndex requires a log. This function itself takes no log/channel
  // parameter, so the default stays a no-op rather than growing this signature for it — but the
  // real caller (extension.ts) passes its own outputChannel-backed buildIndex explicitly, so the
  // walker's skip/cycle/broken-link surfacing does reach the Output channel in production; this
  // default only fires for a caller (e.g. a test) that doesn't supply one.
  buildIndex: BuildIndex = (entries, root) => buildFileConflictIndex(entries, root, () => {}),
): Promise<LoadOrderPlugin[]> {
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
  const slotByName = new Map(names.map((name, slot) => [foldPath(name), slot] as const));

  const listed: LoadOrderPlugin[] = names.map((name, slot) => {
    const overwriteFile = overwriteFiles.get(foldPath(name));
    const enabledLine = enabledNames.has(foldPath(name));
    if (overwriteFile !== undefined) {
      return { name, path: join(instanceRoot, 'overwrite', overwriteFile), origin: OVERWRITE_ORIGIN, slot, enabled: enabledLine, winning: true };
    }
    return {
      name,
      path: pathByName.get(name)!,
      origin: winnerModByName.get(foldPath(name)) ?? DATA_DIRECTORY_ORIGIN,
      slot,
      enabled: enabledLine,
      winning: true,
    };
  });

  // Every other copy an enabled mod provides: a file-level loser of a listed name, or a file no
  // line names at all. `winning` is the Mod override order's own answer, independent of listing —
  // an unlisted file's sole provider is still the copy the name resolves to.
  const isWinningCopy = (copy: { name: string; origin: string }) =>
    !overwriteFiles.has(foldPath(copy.name))
    && foldPath(winnerModByName.get(foldPath(copy.name)) ?? '') === foldPath(copy.origin);
  const losers: LoadOrderPlugin[] = findUnlistedPlugins(index, listed.map((p) => ({ name: p.name, origin: p.origin })))
    .map((copy) => ({
      name: copy.name,
      path: copy.path,
      origin: copy.origin,
      slot: slotByName.get(foldPath(copy.name)) ?? null,
      enabled: enabledNames.has(foldPath(copy.name)),
      winning: isWinningCopy(copy),
    }));

  // overwrite/'s own unlisted plugins — winning-most, but no line names them.
  const strays: LoadOrderPlugin[] = [...overwriteFiles]
    .filter(([folded, real]) => !slotByName.has(folded) && isPluginFile(real))
    .map(([, real]) => ({
      name: real, path: join(instanceRoot, 'overwrite', real), origin: OVERWRITE_ORIGIN, slot: null, enabled: false, winning: true,
    }));

  return [...listed, ...losers, ...strays];
}

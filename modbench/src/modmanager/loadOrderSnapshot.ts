// Every physical plugin copy the enabled mods and overwrite/ provide, plus the Data-folder copy
// of any plugins.txt line no mod provides (ADR-0044). Vanilla masters and .ccc content are
// prepended by the backend, never listed here.

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { IModlistSource } from './model';
import { buildFileConflictIndex, foldPath, rootLevelWinnerMods, rootLevelWinners, type FileConflictIndex } from './fileConflictIndex';
import { isPluginFile } from './masterReader';
import { findUnlistedPlugins } from './unlistedPlugins';

// Reserved origin values (ADR-0036), matching their literal directory names. Never a real mod
// folder name: mod folders live under `mods/`.
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

/** Keyed by lowercased name, since plugins.txt casing is not authoritative. Root-level index
 *  files only: a nested file sharing a plugin's basename must not shadow the real plugin. */
export function resolvePluginPaths(
  names: string[],
  index: FileConflictIndex,
  dataFolder: string,
): Map<string, string> {
  const winnerByName = rootLevelWinners(index);
  return new Map(names.map((name) => [name, winnerByName.get(name.toLowerCase()) ?? join(dataFolder, name)]));
}

// MO2's VFS makes overwrite/ winning-most of all, so a plugin found here wins path resolution
// too, not just origin classification. Empty until a purge first creates the folder.
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

/** A disabled plugins.txt line is still sent: its missing `*` becomes `enabled: false` rather
 *  than deciding whether the line appears at all (ADR-0035). */
export async function buildLoadOrderSnapshot(
  source: Source,
  instanceRoot: string,
  dataFolder: string,
  // The real caller passes an outputChannel-backed buildIndex, so the walker's surfacing does
  // reach the Output channel; this no-op default only fires for a caller that supplies none.
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

  // `winning` is the Mod override order's own answer, independent of listing: an unlisted
  // file's sole provider is still the copy the name resolves to.
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

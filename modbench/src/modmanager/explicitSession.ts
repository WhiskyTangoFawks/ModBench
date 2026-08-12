// Assembles the ordered { name, path, origin } list for the backend's `load-explicit`
// session (POST /session/load-explicit) from the active profile's enabled
// plugins. Plugin *order* comes from plugins.txt; each name resolves to its
// winning physical path via the MO2-priority FileConflictIndex, falling back to
// the game's Data folder for a base-game plugin no mod provides. Vanilla masters
// are NOT listed here — the backend prepends them from the game directory.

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { IModlistSource } from './model';
import { buildFileConflictIndex, foldPath, rootLevelWinnerMods, rootLevelWinners, type FileConflictIndex } from './fileConflictIndex';

// Reserved origin values (#269 / ADR-0036): the game's Data directory, and MO2's overwrite
// folder — matching their literal directory names. Never a real mod folder name: mod folders live
// under a different namespace (`mods/`), and "overwrite" is already a reserved MO2 folder name
// elsewhere in this codebase (modlistText.ts's RESERVED_DIR_NAMES).
export const DATA_DIRECTORY_ORIGIN = 'Data';
export const OVERWRITE_ORIGIN = 'overwrite';

export interface ExplicitPlugin {
  name: string;
  path: string;
  /** The mod folder that provided this plugin, or a reserved origin value above (#269 / ADR-0036). */
  origin: string;
}

/** Resolve each plugin name to its winning physical path: the MO2-priority
 *  FileConflictIndex winner for a mod-provided plugin, else the game's Data
 *  folder for a base-game/DLC/CC plugin no mod provides. Keyed by lowercased
 *  name (plugins.txt casing is not authoritative). Only root-level index files
 *  are considered — a nested file sharing a plugin's basename must not shadow
 *  the real plugin. Shared by the editing-session builder and the Plugin List's
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
 *  their real on-disk name (#269 / ADR-0036). MO2's VFS gives overwrite/ the highest priority of
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

type Source = Pick<IModlistSource, 'readEnabledPlugins' | 'readModlist'>;
type BuildIndex = (
  entries: Awaited<ReturnType<IModlistSource['readModlist']>>,
  instanceRoot: string,
) => Promise<FileConflictIndex>;

/** Builds the { name, path, origin } list for the backend's `load-explicit` session — each plugin
 *  also carries the origin Mod Management resolved it from (#269 / ADR-0036). Sole caller is the
 *  "enter editing" call site in extension.ts. */
export async function buildExplicitPluginsWithOrigin(
  source: Source,
  instanceRoot: string,
  dataFolder: string,
  buildIndex: BuildIndex = buildFileConflictIndex,
): Promise<ExplicitPlugin[]> {
  const [names, index, overwriteFiles] = await Promise.all([
    source.readEnabledPlugins(),
    source.readModlist().then((entries) => buildIndex(entries, instanceRoot)),
    overwritePluginFiles(instanceRoot),
  ]);

  const pathByName = resolvePluginPaths(names, index, dataFolder);
  const winnerModByName = rootLevelWinnerMods(index);

  return names.map((name) => {
    const overwriteFile = overwriteFiles.get(foldPath(name));
    if (overwriteFile !== undefined) {
      return { name, path: join(instanceRoot, 'overwrite', overwriteFile), origin: OVERWRITE_ORIGIN };
    }
    return {
      name,
      path: pathByName.get(name)!,
      origin: winnerModByName.get(name.toLowerCase()) ?? DATA_DIRECTORY_ORIGIN,
    };
  });
}

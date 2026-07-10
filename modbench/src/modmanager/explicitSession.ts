// Assembles the ordered { name, path } list for the backend's `load-explicit`
// session (POST /session/load-explicit) from the active profile's enabled
// plugins. Plugin *order* comes from plugins.txt; each name resolves to its
// winning physical path via the MO2-priority FileConflictIndex, falling back to
// the game's Data folder for a base-game plugin no mod provides. Vanilla masters
// are NOT listed here — the backend prepends them from the game directory.

import { join } from 'node:path';
import type { IModlistSource } from './model';
import { buildFileConflictIndex, rootLevelWinners, type FileConflictIndex } from './fileConflictIndex';

export interface ExplicitPlugin {
  name: string;
  path: string;
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

type Source = Pick<IModlistSource, 'readEnabledPlugins' | 'readModlist'>;

export async function buildExplicitPlugins(
  source: Source,
  instanceRoot: string,
  dataFolder: string,
  buildIndex: (
    entries: Awaited<ReturnType<IModlistSource['readModlist']>>,
    instanceRoot: string,
  ) => Promise<FileConflictIndex> = buildFileConflictIndex,
): Promise<ExplicitPlugin[]> {
  const [names, index] = await Promise.all([
    source.readEnabledPlugins(),
    source.readModlist().then((entries) => buildIndex(entries, instanceRoot)),
  ]);

  const pathByName = resolvePluginPaths(names, index, dataFolder);
  return names.map((name) => ({ name, path: pathByName.get(name)! }));
}

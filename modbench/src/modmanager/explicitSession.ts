// Assembles the ordered { name, path } list for the backend's `load-explicit`
// session (POST /session/load-explicit) from the active profile's enabled
// plugins. Plugin *order* comes from plugins.txt; each name resolves to its
// winning physical path via the MO2-priority FileConflictIndex, falling back to
// the game's Data folder for a base-game plugin no mod provides. Vanilla masters
// are NOT listed here — the backend prepends them from the game directory.

import { join } from 'node:path';
import type { IModlistSource } from './model';
import { buildFileConflictIndex, type FileConflictIndex } from './fileConflictIndex';

export interface ExplicitPlugin {
  name: string;
  path: string;
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

  // Root-level files only (plugins live at a mod's root) — a nested file that
  // happens to share a plugin's basename must not shadow the real plugin.
  const winnerByName = new Map<string, string>();
  for (const [relativePath, entry] of index.files) {
    if (!relativePath.includes('/')) winnerByName.set(relativePath.toLowerCase(), entry.winner);
  }

  return names.map((name) => ({
    name,
    path: winnerByName.get(name.toLowerCase()) ?? join(dataFolder, name),
  }));
}

// The plugin files the effective load order does not point at: an overridden plugin in an enabled
// mod, or any plugin in a disabled mod. The snapshot names them too (ADR-0013).

import { foldPath, type FileConflictIndex } from './fileConflictIndex';
import { isPluginFile } from '../instanceAdapter/instanceAdapter';

/** A plugin file the load order does not hold, named as the snapshot names a plugin (ADR-0013). */
export interface PluginOutsideLoadOrder {
  name: string;
  path: string;
  /** The mod folder providing this plugin. */
  origin: string;
}

/** A plugin the load order holds (ADR-0012). */
export interface LoadedPlugin {
  name: string;
  origin: string;
}

function isRootLevelPlugin(relativePath: string): boolean {
  return !relativePath.includes('/') && isPluginFile(relativePath);
}

/** One rule covers both cases: an overridden plugin is a pair whose filename is loaded from a
 *  different origin, a never-listed file one whose filename is not loaded at all. */
export function findPluginsOutsideLoadOrder(
  index: FileConflictIndex, loadOrder: LoadedPlugin[],
): PluginOutsideLoadOrder[] {
  // Case-folded on both halves — a case difference must not read as "a second plugin".
  const addressOf = (origin: string, name: string): string => JSON.stringify([foldPath(origin), foldPath(name)]);
  const loaded = new Set(loadOrder.map((p) => addressOf(p.origin, p.name)));

  const outside: PluginOutsideLoadOrder[] = [];
  for (const [mod, files] of index.filesByMod) {
    for (const file of files) {
      if (!isRootLevelPlugin(file.relativePath)) continue;
      if (loaded.has(addressOf(mod, file.relativePath))) continue;
      outside.push({ name: file.relativePath, path: file.sourcePath, origin: mod });
    }
  }
  return outside;
}

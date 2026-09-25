// The plugin files the effective load order does not point at (ADR-0013). Scope is the enabled
// mods' own folders: a disabled mod is not deployed into the game's view, and
// buildFileConflictIndex doesn't walk it either.

import { foldPath, type FileConflictIndex } from './fileConflictIndex';
import { isPluginFile } from '../instanceAdapter/pluginFile';

/** A plugin file the load order does not hold, addressed the way the backend addresses every
 *  plugin: (origin, filename) plus the physical path to read it from (ADR-0012). */
export interface PluginOutsideLoadOrder {
  name: string;
  path: string;
  /** The mod folder providing this plugin. */
  origin: string;
}

/** The (origin, filename) pairs the editing backend already holds (ADR-0012). */
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
  // Keyed by `origin|filename`: `|` is illegal in a Windows filename and in an MO2 mod-folder
  // name, so it cannot collide with either half. Case-folded on both halves — a case difference
  // must not read as "a second plugin".
  const loaded = new Set(loadOrder.map((p) => `${foldPath(p.origin)}|${foldPath(p.name)}`));

  const outside: PluginOutsideLoadOrder[] = [];
  for (const [mod, files] of index.filesByMod) {
    for (const file of files) {
      if (!isRootLevelPlugin(file.relativePath)) continue;
      if (loaded.has(`${foldPath(mod)}|${foldPath(file.relativePath)}`)) continue;
      outside.push({ name: file.relativePath, path: file.absolutePath, origin: mod });
    }
  }
  return outside;
}

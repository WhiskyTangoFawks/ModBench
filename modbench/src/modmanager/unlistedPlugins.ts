// The plugin files the effective load order does not point at (ADR-0035). Scope is the enabled
// mods' own folders: a disabled mod is not deployed into the game's view, and
// buildFileConflictIndex doesn't walk it either.

import { foldPath, type FileConflictIndex } from './fileConflictIndex';
import { isPluginFile } from './masterReader';

/** A plugin file the load order does not hold, addressed the way the backend addresses every
 *  plugin: (origin, filename) plus the physical path to read it from (ADR-0036). */
export interface UnlistedPlugin {
  name: string;
  path: string;
  /** The mod folder providing this copy. */
  origin: string;
}

/** The (origin, filename) pairs the editing backend already holds (ADR-0036). */
export interface LoadedPlugin {
  name: string;
  origin: string;
}

function isRootLevelPlugin(relativePath: string): boolean {
  return !relativePath.includes('/') && isPluginFile(relativePath);
}

/** One rule covers both cases: a shadowed copy is a pair whose filename is loaded from a
 *  different origin, a never-listed file one whose filename is not loaded at all. */
export function findUnlistedPlugins(index: FileConflictIndex, loadOrder: LoadedPlugin[]): UnlistedPlugin[] {
  // Keyed by `origin|filename`: `|` is illegal in a Windows filename and in an MO2 mod-folder
  // name, so it cannot collide with either half. Case-folded on both halves — a case difference
  // must not read as "a second copy".
  const loaded = new Set(loadOrder.map((p) => `${foldPath(p.origin)}|${foldPath(p.name)}`));

  const unlisted: UnlistedPlugin[] = [];
  for (const [mod, files] of index.filesByMod) {
    for (const file of files) {
      if (!isRootLevelPlugin(file.relativePath)) continue;
      if (loaded.has(`${foldPath(mod)}|${foldPath(file.relativePath)}`)) continue;
      unlisted.push({ name: file.relativePath, path: file.absolutePath, origin: mod });
    }
  }
  return unlisted;
}

// The plugin files the effective load order does not point at (ADR-0035): a copy shadowed by
// a winning mod, and a file plugins.txt never names at all. Pure over the FileConflictIndex Mod
// Management already builds for the Mods tree, so discovery costs no extra filesystem walk.
//
// Scope is deliberately the enabled mods' own folders. Disabled mods are not deployed into the
// game's view at all, so their plugins are not "a copy the load order doesn't point at" in any
// sense a user would recognise — and buildFileConflictIndex doesn't walk them either.
//
// `findUnlistedPlugins`'s result feeds `loadOrderSnapshot.ts`'s every-copy registration
// (ADR-0044): a losing or unnamed copy is registered the same as any other, never loaded
// separately on demand.

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

/** The (origin, filename) pairs the editing backend already holds — `buildExplicitPluginsWithOrigin`'s
 *  own output, narrowed to what identifies a plugin. */
export interface LoadedPlugin {
  name: string;
  origin: string;
}

function isRootLevelPlugin(relativePath: string): boolean {
  return !relativePath.includes('/') && isPluginFile(relativePath);
}

/** Every root-level plugin file provided by an enabled mod that `loadOrder` does not already hold.
 *  One rule covers both cases the ADR names: a shadowed copy is a pair whose filename is loaded
 *  from a *different* origin, and a never-listed file is a pair whose filename is not loaded at
 *  all — neither needs to be distinguished here, because both are equally "not loaded". */
export function findUnlistedPlugins(index: FileConflictIndex, loadOrder: LoadedPlugin[]): UnlistedPlugin[] {
  // Keyed by `origin|filename`. The delimiter is ColumnKey.Of's, for its reason — `|` is illegal
  // in a Windows filename and in an MO2 mod-folder name, so it cannot collide with either half's
  // content — but the order is not, and this is deliberately a private lookup key rather than a
  // ColumnKey: nothing crosses the wire with it, and Mod Management does not speak ColumnKey.
  // Case-folded on both halves: plugins.txt casing is not authoritative (loadOrderSnapshot.ts makes
  // the same point), and a mod folder read off disk can differ in case from the one recorded as an
  // origin. A case difference must not read as "a second copy".
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

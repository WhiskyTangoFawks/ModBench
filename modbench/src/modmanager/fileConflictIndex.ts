// The effective merged mod view — the same priority merge a VFS/MO2 performs.
// Pure over ModlistEntry[] + instanceRoot; no vscode import, unit-testable
// standalone like modlistTree.ts.

import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { ModlistEntry } from './model';

/** Never deployed into Data/ by MO2 — excluded so every mod (nearly all of
 *  which have one) doesn't spuriously "conflict" with every other mod on it. */
const EXCLUDED_RELATIVE_PATHS = new Set(['meta.ini']);

export interface ConflictEntry {
  /** The winning provider's own relative path, in its original on-disk casing —
   *  display + link target. Proton/Wine resolves paths case-insensitively over
   *  ext4's case-sensitive mods/, so two mods providing case-variant paths
   *  (Textures/Foo.dds vs textures/foo.dds) must resolve to ONE entry; this
   *  keeps the winner's own casing rather than an arbitrarily-folded one. */
  relativePath: string;
  /** Absolute path of the winning enabled provider (nearest the winning end). */
  winner: string;
  winnerMod: string;
  /** Every enabled mod providing this relative path. */
  providers: string[];
}

/** Case-fold a relative path for comparison-key purposes only — never for
 *  display, and never written back to disk. Plain toLowerCase(), matching this
 *  module's existing rootLevelWinners convention: locale-independent, since a
 *  case-variant collision is an ext4/Proton filesystem fact, not a
 *  locale-dependent one. */
export function foldPath(relativePath: string): string {
  return relativePath.toLowerCase();
}

/** Conflict/winner lookup keyed by case-folded path, so a case-variant pair
 *  (Textures/Foo.dds vs textures/foo.dds) resolves to one entry no matter which
 *  casing a caller looks up with. No raw Map is exposed: there is no
 *  bracket/`.get` access a caller could perform with an unfolded path and
 *  silently miss — that silent miss was the original bug (#128). */
export class FileConflictLookup {
  private readonly byFoldedPath = new Map<string, ConflictEntry>();

  set(entry: ConflictEntry): void {
    this.byFoldedPath.set(foldPath(entry.relativePath), entry);
  }

  get(relativePath: string): ConflictEntry | undefined {
    return this.byFoldedPath.get(foldPath(relativePath));
  }

  has(relativePath: string): boolean {
    return this.byFoldedPath.has(foldPath(relativePath));
  }

  values(): IterableIterator<ConflictEntry> {
    return this.byFoldedPath.values();
  }

  [Symbol.iterator](): IterableIterator<ConflictEntry> {
    return this.values();
  }

  get size(): number {
    return this.byFoldedPath.size;
  }
}

export interface FileConflictIndex {
  /** Conflict/winner info, for every path provided by >=1 enabled mod. */
  files: FileConflictLookup;
  /** Each enabled mod's own files, so callers don't need a second filesystem walk. */
  filesByMod: Map<string, { relativePath: string; absolutePath: string }[]>;
}

/** Winning absolute path of every root-level plugin the index knows, keyed by
 *  lowercased basename. Root-level only: plugins live at a mod's root, so a
 *  nested file sharing a plugin's basename must not shadow the real plugin.
 *  Shared by the editing-session builder and the Plugin List's order check. */
export function rootLevelWinners(index: FileConflictIndex): Map<string, string> {
  const winnerByName = new Map<string, string>();
  for (const entry of index.files) {
    if (!entry.relativePath.includes('/')) winnerByName.set(foldPath(entry.relativePath), entry.winner);
  }
  return winnerByName;
}

async function walk(dir: string, root = dir): Promise<{ relativePath: string; absolutePath: string }[]> {
  const dirents = await readdir(dir, { withFileTypes: true });
  const results: { relativePath: string; absolutePath: string }[] = [];
  for (const dirent of dirents) {
    const absolutePath = join(dir, dirent.name);
    if (dirent.isDirectory()) {
      results.push(...(await walk(absolutePath, root)));
    } else if (dirent.isFile()) {
      const relativePath = relative(root, absolutePath).split(sep).join('/');
      if (!EXCLUDED_RELATIVE_PATHS.has(relativePath)) {
        results.push({ relativePath, absolutePath });
      }
    }
  }
  return results;
}

async function walkMod(instanceRoot: string, modName: string): Promise<{ relativePath: string; absolutePath: string }[]> {
  try {
    return await walk(join(instanceRoot, 'mods', modName));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []; // missing mod folder — StatusChecker's concern
    throw err;
  }
}

export async function buildFileConflictIndex(
  entries: ModlistEntry[],
  instanceRoot: string,
): Promise<FileConflictIndex> {
  const files = new FileConflictLookup();
  const filesByMod = new Map<string, { relativePath: string; absolutePath: string }[]>();

  const enabledMods = entries.filter((e) => e.kind === 'mod' && e.enabled);

  // Each mod's disk walk is independent, so run them concurrently; only the
  // merge below needs priority order.
  const walked = await Promise.all(enabledMods.map((mod) => walkMod(instanceRoot, mod.name)));

  // Entries are in modlist.txt file order, top-first. The top of the file is the
  // winning end of the Mod override order (MO2 pins vanilla/base to losing-most;
  // every mod above overrides it), so the FIRST enabled provider wins. Merge in
  // list order, keeping the earliest writer as the winner — later providers only
  // register as contenders. See modmanager/CONTEXT.md ("Override order").
  for (let i = 0; i < enabledMods.length; i++) {
    const mod = enabledMods[i];
    const modFiles = walked[i];
    filesByMod.set(mod.name, modFiles);

    for (const file of modFiles) {
      const existing = files.get(file.relativePath);
      if (existing) {
        existing.providers.push(mod.name); // loses to the earlier (winning) provider
      } else {
        files.set({
          relativePath: file.relativePath,
          winner: file.absolutePath,
          winnerMod: mod.name,
          providers: [mod.name],
        });
      }
    }
  }

  return { files, filesByMod };
}

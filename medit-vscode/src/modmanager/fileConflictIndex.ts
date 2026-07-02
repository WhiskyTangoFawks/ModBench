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
  /** Absolute path of the highest-priority enabled provider. */
  winner: string;
  winnerMod: string;
  /** Every enabled mod providing this relative path. */
  providers: string[];
}

export interface FileConflictIndex {
  /** relativePath (forward-slash separated) -> conflict/winner info, for every path provided by >=1 enabled mod. */
  files: Map<string, ConflictEntry>;
  /** Each enabled mod's own files, so callers don't need a second filesystem walk. */
  filesByMod: Map<string, { relativePath: string; absolutePath: string }[]>;
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
  const files = new Map<string, ConflictEntry>();
  const filesByMod = new Map<string, { relativePath: string; absolutePath: string }[]>();

  const enabledMods = entries.filter((e) => e.kind === 'mod' && e.enabled);

  // Each mod's disk walk is independent, so run them concurrently; only the
  // merge below needs priority order.
  const walked = await Promise.all(enabledMods.map((mod) => walkMod(instanceRoot, mod.name)));

  // Array index 0 = highest priority (top of modlist.txt). The spec's merge
  // ("ascending priority... later wins") needs lowest-priority processed
  // first, so we merge in reverse and let the highest-priority mod's writes
  // land last and win.
  for (let i = enabledMods.length - 1; i >= 0; i--) {
    const mod = enabledMods[i];
    const modFiles = walked[i];
    filesByMod.set(mod.name, modFiles);

    for (const file of modFiles) {
      const existing = files.get(file.relativePath);
      if (existing) {
        existing.providers.push(mod.name);
        existing.winner = file.absolutePath;
        existing.winnerMod = mod.name;
      } else {
        files.set(file.relativePath, {
          winner: file.absolutePath,
          winnerMod: mod.name,
          providers: [mod.name],
        });
      }
    }
  }

  return { files, filesByMod };
}

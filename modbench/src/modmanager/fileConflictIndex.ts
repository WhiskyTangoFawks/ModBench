// The effective merged mod view — the merge a VFS performs over the Mod override order.
// No vscode import, so it is unit-testable standalone.

import { readdir, realpath, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { ModlistEntry } from './model';

// Nearly every mod has one, so indexing it would make them all conflict with each other.
const EXCLUDED_RELATIVE_PATHS = new Set(['meta.ini']);

// Matched at the mod root only: Papyrus assets ship nested (`Scripts/Source/...`), so a bare
// name match at any depth would exclude a mod's own scripts.
const ROOT_SOURCE_FOLDER_NAME = 'source';

// Any depth, any dirent kind: a stray `.DS_Store` is as much "not mod content" as `.git`.
function isDotPrefixed(name: string): boolean {
  return name.startsWith('.');
}

function isExcludedSourceDirectory(name: string, dir: string, root: string): boolean {
  return dir === root && foldPath(name) === ROOT_SOURCE_FOLDER_NAME;
}

export interface ConflictEntry {
  /** The winner's own on-disk casing: Proton/Wine folds case over case-sensitive ext4, so
   *  case-variant paths resolve to one entry, kept at that casing rather than a folded one. */
  relativePath: string;
  /** Absolute path of the winning enabled provider (nearest the winning end). */
  winner: string;
  winnerMod: string;
  /** Every enabled mod providing this relative path. */
  providers: string[];
}

/** Comparison keys only — never display, never written back to disk. Locale-independent,
 *  since a case-variant collision is a filesystem fact rather than a locale one. */
export function foldPath(relativePath: string): string {
  return relativePath.toLowerCase();
}

/** Keyed by case-folded path, so a case-variant pair resolves to one entry. No raw Map is
 *  exposed: a caller cannot look up with an unfolded path and silently miss. */
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

/** The winner lookup minus its one mutator: a value is replaced whole, never patched (ADR-0015).
 *  Every reader of the Instance's `files` field, the deployer included, takes this. */
export type FileWinners = Omit<FileConflictLookup, 'set'>;

export interface FileConflictIndex {
  /** Conflict/winner info, for every path provided by >=1 enabled mod. */
  files: FileConflictLookup;
  /** Each enabled mod's own files, so callers don't need a second filesystem walk. */
  filesByMod: Map<string, { relativePath: string; absolutePath: string }[]>;
}

// Plugins live at a mod's root, so a nested file sharing a plugin's basename must not match.
function rootLevelEntries(index: FileConflictIndex): ConflictEntry[] {
  return [...index.files].filter((entry) => !entry.relativePath.includes('/'));
}

/** Keyed by lowercased basename; root-level only, so every key is a bare basename and a
 *  slash-free plugin-filename query can never reach a nested entry. */
export function rootLevelWinners(index: FileConflictIndex): Map<string, string> {
  return new Map(rootLevelEntries(index).map((entry) => [foldPath(entry.relativePath), entry.winner]));
}

/** The origin-resolution twin of `rootLevelWinners` (ADR-0012), under the same
 *  root-level-only contract. */
export function rootLevelWinnerMods(index: FileConflictIndex): Map<string, string> {
  return new Map(rootLevelEntries(index).map((entry) => [foldPath(entry.relativePath), entry.winnerMod]));
}

// Non-regular dirent policy is specified in docs/specs/mods.md: follow symlinks as MO2 does,
// skip and log a broken link or a cycle, propagate any other stat failure.
async function walk(
  dir: string,
  root: string,
  ancestors: Set<string>,
  log: (msg: string) => void,
): Promise<{ relativePath: string; absolutePath: string }[]> {
  const dirents = await readdir(dir, { withFileTypes: true });
  const results: { relativePath: string; absolutePath: string }[] = [];
  for (const dirent of dirents) {
    // Dot-prefixed at any depth, any dirent kind — checked first, ahead of every other
    // rule, since it needs none of their context (root-relative or not, file or directory).
    if (isDotPrefixed(dirent.name)) continue;
    const absolutePath = join(dir, dirent.name);
    if (dirent.isDirectory()) {
      if (isExcludedSourceDirectory(dirent.name, dir, root)) continue;
      results.push(...(await descend(absolutePath, root, ancestors, log)));
    } else if (dirent.isFile()) {
      pushEntry(results, root, absolutePath);
    } else if (dirent.isSymbolicLink()) {
      results.push(...(await walkSymlink(absolutePath, root, ancestors, log)));
    } else {
      log(`[fileConflictIndex] non-regular entry (socket/FIFO/device node), skipping: "${absolutePath}"`);
    }
  }
  return results;
}

async function walkSymlink(
  absolutePath: string,
  root: string,
  ancestors: Set<string>,
  log: (msg: string) => void,
): Promise<{ relativePath: string; absolutePath: string }[]> {
  let target;
  try {
    target = await stat(absolutePath); // follows the link
  } catch (err) {
    // ENOENT (broken link) only — any other stat failure (e.g. EACCES) propagates rather
    // than silently degrading to a skip, matching statusChecker.ts's modFolderExists
    // convention: a permission error must reject, not read as "nothing here".
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    log(`[fileConflictIndex] broken symlink, skipping: "${absolutePath}" (${err instanceof Error ? err.message : String(err)})`);
    return [];
  }
  if (target.isDirectory()) return descend(absolutePath, root, ancestors, log);
  if (target.isFile()) {
    // Resolve to the real file so the deployer hardlinks the target, not the link itself;
    // the relativePath key still comes from the symlink's own name.
    const results: { relativePath: string; absolutePath: string }[] = [];
    pushEntry(results, root, absolutePath, await realpath(absolutePath));
    return results;
  }
  log(`[fileConflictIndex] symlink target is not a file or directory, skipping: "${absolutePath}"`);
  return [];
}

// One realpath per directory, uniform rather than symlink-only, so there is a single cycle
// guard to verify instead of two conditionally-correct ones.
async function descend(
  dirPath: string,
  root: string,
  ancestors: Set<string>,
  log: (msg: string) => void,
): Promise<{ relativePath: string; absolutePath: string }[]> {
  const real = await realpath(dirPath);
  if (ancestors.has(real)) {
    log(`[fileConflictIndex] symlink cycle detected at "${dirPath}", skipping`);
    return [];
  }
  return walk(dirPath, root, new Set(ancestors).add(real), log);
}

// `fs.link`'s final path component does not dereference a symlink on Linux, so a symlinked
// file needs `sourcePath` at its realpath while `walkedPath` keeps the key.
function pushEntry(
  results: { relativePath: string; absolutePath: string }[],
  root: string,
  walkedPath: string,
  sourcePath: string = walkedPath,
): void {
  const relativePath = relative(root, walkedPath).split(sep).join('/');
  if (!EXCLUDED_RELATIVE_PATHS.has(relativePath)) {
    results.push({ relativePath, absolutePath: sourcePath });
  }
}

async function walkMod(
  instanceRoot: string,
  modName: string,
  log: (msg: string) => void,
): Promise<{ relativePath: string; absolutePath: string }[]> {
  const dir = join(instanceRoot, 'mods', modName);
  try {
    const rootReal = await realpath(dir);
    return await walk(dir, dir, new Set([rootReal]), log);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []; // missing mod folder — StatusChecker's concern
    throw err;
  }
}

export async function buildFileConflictIndex(
  entries: ModlistEntry[],
  instanceRoot: string,
  log: (msg: string) => void,
): Promise<FileConflictIndex> {
  const files = new FileConflictLookup();
  const filesByMod = new Map<string, { relativePath: string; absolutePath: string }[]>();

  const enabledMods = entries.filter((e) => e.kind === 'mod' && e.enabled);

  // Each mod's disk walk is independent, so run them concurrently; only the merge below
  // needs the override order.
  const walked = await Promise.all(enabledMods.map((mod) => walkMod(instanceRoot, mod.name, log)));

  // modlist.txt is winning-first, so the FIRST enabled provider wins and later ones only
  // register as contenders (CONTEXT.md, "Override order").
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

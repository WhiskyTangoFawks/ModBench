// The effective merged mod view — the same priority merge a VFS/MO2 performs.
// Pure over ModlistEntry[] + instanceRoot; no vscode import, unit-testable
// standalone like modlistTree.ts.

import { readdir, realpath, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { ModlistEntry } from './model';

/** Never deployed into Data/ by MO2 — excluded so every mod (nearly all of
 *  which have one) doesn't spuriously "conflict" with every other mod on it. */
const EXCLUDED_RELATIVE_PATHS = new Set(['meta.ini']);

/** The layout's own exclusion — `SourceRecordPath.RootFor` in
 *  `MEditService.Core/Source/` always builds `source/<plugin>/...`, one root folder per mod. Mod
 *  Management stays pure TS and learns this by convention (the fixed name), never by calling the
 *  backend. Root-anchored (matched only at the mod root) and case-insensitive (`foldPath`),
 *  needing no sibling-plugin check: the whole folder is excluded unconditionally, which closes
 *  the orphaning trap by construction (a plugin renamed or deleted outside Modbench
 *  can never leave part of `source/` behind un-excluded, because nothing about the exclusion
 *  depends on which plugins still exist). Root-anchoring specifically (not a bare name match at
 *  any depth) is what keeps a mod's own Papyrus assets safe: those ship nested
 *  (`Scripts/Source/...`), never at the mod root, so `Data/source` has no game meaning and
 *  losing it costs nothing real. */
const ROOT_SOURCE_FOLDER_NAME = 'source';

/** Never deployed or indexed as mod content, at any depth — a tracked mod's `.git/` must
 *  never be walked and deployed like ordinary content. Applies
 *  uniformly to every dirent kind (file, directory, symlink), unlike the source-tree guard above
 *  which is directory-only and root-only: a dot-prefixed *file* nested anywhere (a stray
 *  `.DS_Store`, an editor swap file) is exactly as much "not mod content" as `.git` itself. */
function isDotPrefixed(name: string): boolean {
  return name.startsWith('.');
}

/** `walk`'s own directory-skip decision, split out to keep that function's cyclomatic/cognitive
 *  complexity down: is `name` (a directory at `dir`) the layout's own root `source/` folder
 *  (root-only — see `ROOT_SOURCE_FOLDER_NAME`)? A match means "do not descend into this
 *  directory". */
function isExcludedSourceDirectory(name: string, dir: string, root: string): boolean {
  return dir === root && foldPath(name) === ROOT_SOURCE_FOLDER_NAME;
}

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
 *  silently miss. */
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

/** Every root-level entry the index knows — plugins live at a mod's root, so a nested file
 *  sharing a plugin's basename must be excluded here. Shared by rootLevelWinners and
 *  rootLevelWinnerMods below, which are otherwise identical apart from which field they read. */
function rootLevelEntries(index: FileConflictIndex): ConflictEntry[] {
  return [...index.files].filter((entry) => !entry.relativePath.includes('/'));
}

/** Winning absolute path of every root-level plugin the index knows, keyed by lowercased
 *  basename. Shared by the editing-load order builder and the Plugin List's order check.
 *  Root-level-only is this function's own documented contract: every key it produces is a bare
 *  basename (no `/`, since a root-level relativePath already is one), matching how both real
 *  callers (resolvePluginPaths here, computePluginOrderStatuses in statusChecker.ts) query it —
 *  by plain plugin filename, which never contains `/`. A slash-free query can never equal a
 *  nested entry's slash-containing key, so rootLevelEntries' filter is what keeps this map's
 *  keys within its own documented basename contract, not a defense against any specific caller. */
export function rootLevelWinners(index: FileConflictIndex): Map<string, string> {
  return new Map(rootLevelEntries(index).map((entry) => [foldPath(entry.relativePath), entry.winner]));
}

/** Winning mod's folder name for every root-level plugin the index knows, keyed by lowercased
 *  basename — the origin-resolution twin of rootLevelWinners above (ADR-0036). Same
 *  root-level-only contract; used by loadOrderSnapshot.ts to record a mod-provided plugin's
 *  origin. */
export function rootLevelWinnerMods(index: FileConflictIndex): Map<string, string> {
  return new Map(rootLevelEntries(index).map((entry) => [foldPath(entry.relativePath), entry.winnerMod]));
}

/** Non-regular dirent policy inside `mods/<Mod>/`. `references/modorganizer/`
 *  (grep-only, checked first) sets the precedent: its own walker
 *  (`DirectoryWalker::forEachEntry`, `src/envfs.cpp`, consumed by
 *  `DirectoryEntry::addFiles` in `src/shared/directoryentry.cpp`) classifies purely on
 *  `FILE_ATTRIBUTE_DIRECTORY` — a directory reparse point (Windows symlink/junction) is
 *  recursed exactly like a real directory, a file reparse point is read exactly like a
 *  real file, and a failed open just logs and stops that branch. No cycle guard exists
 *  there; MO2 leans on NTFS's own reparse-hop ceiling to stay finite, which has no Linux
 *  equivalent for an application-level directory walk. This walker follows MO2's lead —
 *  follow transparently, surface what fails — and adds the cycle guard MO2 gets for free:
 *   - A symlink is followed to whatever it resolves to (file or directory); the target
 *     participates in the index exactly as if it weren't a link — deploy through the
 *     link. For a symlinked *file* this means the entry's source is the realpath-resolved
 *     target, not the symlink's own path: `fs.link`'s final path component doesn't
 *     dereference a symlink on Linux, so the deployer would otherwise hardlink the link
 *     itself. The relativePath key is unaffected — still the symlink's own name in the mod
 *     tree. A symlinked *directory* needs no such resolution: only its own final path
 *     component is a link, and everything found by walking through it already resolves
 *     correctly. This is what makes a user's shared-asset-folder symlink inside a mod work.
 *   - A broken symlink (ENOENT) is skipped — logged, never thrown. Any other stat failure
 *     (e.g. permission denied) propagates instead of silently degrading to a skip, matching
 *     statusChecker.ts's `modFolderExists` convention.
 *   - Every directory entered — real or reached via a followed symlink — is realpath-
 *     tracked against its own ancestors; a revisit is a cycle (`mods/ModA/link -> ModA`,
 *     or a multi-hop loop), skipped and logged rather than recursed forever.
 *   - A socket, FIFO, or device node is never mod content — always skipped, always logged. */
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

/** The symlink branch of `walk`'s policy, split out to keep both functions' own
 *  complexity low: resolve what the link points to and dispatch exactly like `walk` would
 *  for a real entry of that type, or skip+log for broken/non-regular targets. */
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
    // Resolve to the real file so the deployer hardlinks the target, not the link itself
    // (see pushEntry's doc comment) — the relativePath key still comes from the symlink's
    // own name via walkedPath.
    const results: { relativePath: string; absolutePath: string }[] = [];
    pushEntry(results, root, absolutePath, await realpath(absolutePath));
    return results;
  }
  log(`[fileConflictIndex] symlink target is not a file or directory, skipping: "${absolutePath}"`);
  return [];
}

/** Recurse into a directory — real or reached via a followed symlink — guarding against a
 *  symlink cycle by realpath-tracking every directory against its own ancestors. One
 *  extra stat-family call per directory, negligible against a walk measured at ~0.14s over
 *  14,865 files (docs/specs/mods.md) — uniform for every directory rather than only
 *  symlinked ones, so there is one code path to verify instead of two conditionally-correct
 *  ones. */
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

/** `walkedPath` is what the relativePath key is computed from — a symlink's own name in
 *  the mod tree, never resolved. `sourcePath` is what the entry's `absolutePath` field
 *  becomes (and, via `buildFileConflictIndex`, the `winner` the deployer `fs.link()`s);
 *  it defaults to `walkedPath` and is only ever overridden for a symlinked file, to the
 *  realpath-resolved target — `fs.link`'s final path component does not dereference
 *  a symlink on Linux, so linking the symlink's own path would hardlink the link itself
 *  (landing as a second, possibly-broken symlink in Data/, not a copy of the real file). */
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

  // Each mod's disk walk is independent, so run them concurrently; only the
  // merge below needs priority order.
  const walked = await Promise.all(enabledMods.map((mod) => walkMod(instanceRoot, mod.name, log)));

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

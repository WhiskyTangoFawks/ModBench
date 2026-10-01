// The effective merged mod view — the merge a VFS performs over the Mod override order.

import type { InstanceAdapter, ModlistEntry } from '../instanceAdapter/instanceAdapter';

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
 *  Every reader of the Instance's `files` field takes this. */
export type FileWinners = Omit<FileConflictLookup, 'set'>;

export interface FileConflictIndex {
  /** Conflict/winner info, for every path provided by >=1 enabled mod. */
  files: FileConflictLookup;
  /** Each enabled mod's own files, so callers don't need a second filesystem walk. */
  filesByMod: Map<string, { relativePath: string; absolutePath: string }[]>;
  /** Each disabled mod's own files, read in the same walk, outside conflict resolution
   *  (ADR-0013, invariant 2). */
  disabledModFiles: Map<string, { relativePath: string; absolutePath: string }[]>;
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

// A mod's own files as the adapter lists them; each entry the listing skipped is one Output line.
async function modFiles(
  adapter: Pick<InstanceAdapter, 'originFiles'>, modName: string, log: (msg: string) => void,
): Promise<{ relativePath: string; absolutePath: string }[]> {
  const { files, notes } = await adapter.originFiles({ kind: 'mod', name: modName });
  for (const note of notes) log(`[fileConflictIndex] ${modName}: ${note}`);
  return files.map((file) => ({ relativePath: file.relativePath, absolutePath: file.path }));
}

export async function buildFileConflictIndex(
  entries: readonly ModlistEntry[],
  adapter: Pick<InstanceAdapter, 'originFiles'>,
  log: (msg: string) => void,
): Promise<FileConflictIndex> {
  const files = new FileConflictLookup();
  const filesByMod = new Map<string, { relativePath: string; absolutePath: string }[]>();
  const disabledModFiles = new Map<string, { relativePath: string; absolutePath: string }[]>();

  const mods = entries.filter((e): e is Extract<ModlistEntry, { kind: 'mod' }> => e.kind === 'mod');

  // Every mod's listing is independent, so run them concurrently; only the merge below needs the
  // override order, and only among enabled mods.
  const listed = await Promise.all(
    mods.map(async (mod) => ({ mod, files: await modFiles(adapter, mod.name, log) })),
  );

  // Mod order is winning-first, so the FIRST enabled provider wins and later ones only
  // register as contenders (CONTEXT.md, "Override order").
  for (const { mod, files: ownFiles } of listed) {
    if (!mod.enabled) {
      disabledModFiles.set(mod.name, ownFiles);
      continue;
    }
    filesByMod.set(mod.name, ownFiles);

    for (const file of ownFiles) {
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

  return { files, filesByMod, disabledModFiles };
}

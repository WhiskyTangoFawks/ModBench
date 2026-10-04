// The effective merged mod view — the merge a VFS performs over the Mod override order.

import type { FileOrigin, InstanceAdapter, ModlistEntry, OriginFile, OriginFolder } from '../instanceAdapter/instanceAdapter';

export const modOrigin = (name: string): FileOrigin => ({ kind: 'mod', name });

export const RUNTIME_OUTPUT: FileOrigin = { kind: 'runtimeOutput' };

export const OVERWRITE_LABEL = 'Overwrite';

export const originLabel = (origin: FileOrigin): string => (origin.kind === 'mod' ? origin.name : OVERWRITE_LABEL);

export const sameOrigin = (a: FileOrigin, b: FileOrigin): boolean =>
  a.kind === 'mod' ? b.kind === 'mod' && a.name === b.name : a.kind === b.kind;

export interface ConflictEntry {
  /** The winner's own on-disk casing: Proton/Wine folds case over case-sensitive ext4, so
   *  case-variant paths resolve to one entry, kept at that casing rather than a folded one. */
  relativePath: string;
  /** Absolute path of the winning enabled provider (nearest the winning end). */
  winner: string;
  winnerOrigin: FileOrigin;
  /** Every provider of this relative path, winning-most first. */
  providers: FileOrigin[];
}

/** The winning copy when `own` loses, and the copies `own` wins over, winning-first, when it
 *  wins. None unless another enabled copy provides the path. */
export function goToModCandidates(entry: ConflictEntry | undefined, own: FileOrigin): FileOrigin[] {
  const providers = entry?.providers ?? [];
  const at = providers.findIndex((provider) => sameOrigin(provider, own));
  if (at === -1) return [];
  return at === 0 ? providers.slice(1) : providers.slice(0, 1);
}

/** Whether `own` provides the path, and another enabled copy or Overwrite's does too. */
export function inFileOrderConflict(entry: ConflictEntry | undefined, own: FileOrigin): boolean {
  const providers = entry?.providers ?? [];
  return providers.length > 1 && providers.some((provider) => sameOrigin(provider, own));
}

export type FileOrderConflict = 'none' | 'wins' | 'loses';

/** Whether `own`'s copy is in a file order conflict, and wins it or loses it to another enabled
 *  copy or Overwrite. */
export function fileOrderConflictOf(entry: ConflictEntry | undefined, own: FileOrigin): FileOrderConflict {
  if (entry === undefined || !inFileOrderConflict(entry, own)) return 'none';
  return sameOrigin(entry.winnerOrigin, own) ? 'wins' : 'loses';
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

/** The winner lookup minus its one mutator (ADR-0015).
 *  Every reader of the Instance's `files` field takes this. */
export type FileWinners = Omit<FileConflictLookup, 'set'>;

export interface FileConflictIndex {
  /** Conflict/winner info, for every path provided by >=1 enabled mod or by Overwrite. */
  files: FileConflictLookup;
  /** Each listed mod's own files, a disabled mod's too, so callers don't need a second
   *  filesystem walk. */
  filesByMod: Map<string, readonly OriginFile[]>;
  /** Each listed mod's folders, as `filesByMod` holds its files. */
  foldersByMod: Map<string, readonly OriginFolder[]>;
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
 *  root-level-only contract. A path Overwrite wins has no mod winner and no entry. */
export function rootLevelWinnerMods(index: FileConflictIndex): Map<string, string> {
  const modWinners = rootLevelEntries(index).flatMap((entry): [string, string][] =>
    entry.winnerOrigin.kind === 'mod' ? [[foldPath(entry.relativePath), entry.winnerOrigin.name]] : []);
  return new Map(modWinners);
}

// A mod's own files and folders as the adapter lists them; each entry the listing skipped is one
// Output line.
async function modListing(
  adapter: Pick<InstanceAdapter, 'originFiles'>, modName: string, log: (msg: string) => void,
): Promise<{ files: readonly OriginFile[]; folders: readonly OriginFolder[] }> {
  const { files, folders, notes } = await adapter.originFiles(modOrigin(modName));
  for (const note of notes) log(`[fileConflictIndex] ${modName}: ${note}`);
  return { files, folders };
}

// A later provider loses to the earlier, winning one. A case variant of a path its mod already
// provides is one more name for that mod's copy, never a second provider.
function provideAsMod(files: FileConflictLookup, file: OriginFile, origin: FileOrigin): void {
  const existing = files.get(file.relativePath);
  if (!existing) {
    files.set({ relativePath: file.relativePath, winner: file.sourcePath, winnerOrigin: origin, providers: [origin] });
  } else if (!existing.providers.some((provider) => sameOrigin(provider, origin))) {
    existing.providers.push(origin);
  }
}

export async function buildFileConflictIndex(
  entries: readonly ModlistEntry[],
  overwriteFiles: readonly OriginFile[],
  adapter: Pick<InstanceAdapter, 'originFiles'>,
  log: (msg: string) => void,
): Promise<FileConflictIndex> {
  const files = new FileConflictLookup();
  const filesByMod = new Map<string, readonly OriginFile[]>();
  const foldersByMod = new Map<string, readonly OriginFolder[]>();

  const mods = entries.filter((e): e is Extract<ModlistEntry, { kind: 'mod' }> => e.kind === 'mod');

  // Every mod's listing is independent, so run them concurrently; only the merge below needs the
  // override order, and only among enabled mods.
  const listed = await Promise.all(
    mods.map(async (mod) => ({ mod, ...await modListing(adapter, mod.name, log) })),
  );

  // Mod order is winning-first, so the FIRST enabled provider wins and later ones only
  // register as contenders (CONTEXT.md, "Override order").
  for (const { mod, files: ownFiles, folders } of listed) {
    filesByMod.set(mod.name, ownFiles);
    foldersByMod.set(mod.name, folders);
    if (!mod.enabled) continue;

    for (const file of ownFiles.filter((own) => !own.excluded)) provideAsMod(files, file, modOrigin(mod.name));
  }

  // The run-time output wins over every mod.
  for (const file of overwriteFiles.filter((own) => !own.excluded)) {
    const existing = files.get(file.relativePath);
    if (existing && sameOrigin(existing.winnerOrigin, RUNTIME_OUTPUT)) continue;
    files.set({
      relativePath: file.relativePath,
      winner: file.sourcePath,
      winnerOrigin: RUNTIME_OUTPUT,
      providers: [RUNTIME_OUTPUT, ...(existing?.providers ?? [])],
    });
  }

  return { files, filesByMod, foldersByMod };
}

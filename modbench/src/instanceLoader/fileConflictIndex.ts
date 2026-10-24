// The effective merged mod view — the merge a VFS performs over the Mod override order.

import { filesWinningFirst, type FileOrigin, type ModlistEntry, type OriginFile, type OriginFiles, type OriginFolder } from '../instanceAdapter/instanceAdapter';

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

/** The winning copy when `own` loses the path, and the copies `own` outranks, winning-first, when
 *  it wins the path. None unless another enabled copy provides the path. */
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

/** Whether `own` wins the path: its copy is the one the game gets. */
export const winsPath = (entry: ConflictEntry | undefined, own: FileOrigin): boolean =>
  entry !== undefined && sameOrigin(entry.winnerOrigin, own);

/** Whether `own` outranks a copy: it provides the path and a lower copy does too, whether or not
 *  it wins the path. */
export function outranksACopy(entry: ConflictEntry | undefined, own: FileOrigin): boolean {
  const providers = entry?.providers ?? [];
  const at = providers.findIndex((provider) => sameOrigin(provider, own));
  return at !== -1 && at < providers.length - 1;
}

export type FileOrderConflict = 'none' | 'wins' | 'loses';

/** Whether `own`'s copy is in a file order conflict, and wins it or loses it to another enabled
 *  copy or Overwrite. */
export function fileOrderConflictOf(entry: ConflictEntry | undefined, own: FileOrigin): FileOrderConflict {
  if (entry === undefined || !inFileOrderConflict(entry, own)) return 'none';
  return winsPath(entry, own) ? 'wins' : 'loses';
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

  values(): IterableIterator<ConflictEntry> {
    return this.byFoldedPath.values();
  }

  [Symbol.iterator](): IterableIterator<ConflictEntry> {
    return this.values();
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

// A later provider loses to the earlier, winning one. A case variant of a path its origin already
// provides is one more name for that origin's copy, never a second provider.
function provide(files: FileConflictLookup, file: OriginFile, origin: FileOrigin): void {
  const existing = files.get(file.relativePath);
  if (!existing) {
    files.set({ relativePath: file.relativePath, winner: file.sourcePath, winnerOrigin: origin, providers: [origin] });
  } else if (!existing.providers.some((provider) => sameOrigin(provider, origin))) {
    existing.providers.push(origin);
  }
}

export function buildFileConflictIndex(
  entries: readonly ModlistEntry[],
  overwriteFiles: readonly OriginFile[],
  modFiles: ReadonlyMap<string, OriginFiles>,
): FileConflictIndex {
  const files = new FileConflictLookup();
  const filesByMod = new Map<string, readonly OriginFile[]>();
  const foldersByMod = new Map<string, readonly OriginFolder[]>();

  for (const mod of entries.filter((entry) => entry.kind === 'mod')) {
    const listing = modFiles.get(mod.name);
    if (listing === undefined) throw new Error(`The reading holds no files for ${mod.name}`);
    filesByMod.set(mod.name, listing.files);
    foldersByMod.set(mod.name, listing.folders);
  }

  for (const { origin, files: provided } of filesWinningFirst(entries, overwriteFiles, (mod) => filesByMod.get(mod) ?? [])) {
    for (const file of provided) provide(files, file, origin);
  }

  return { files, filesByMod, foldersByMod };
}

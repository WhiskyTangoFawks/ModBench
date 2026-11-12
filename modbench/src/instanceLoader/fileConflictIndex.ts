// The effective merged mod view — the merge a VFS performs over the Mod override order.

import {
  filesWinningFirst, type FileOrigin, type ModlistEntry, type OriginFile, type OriginFiles, type OriginFolder, type OriginProvides,
} from '../instanceAdapter/instanceAdapter';

export const modOrigin = (name: string): FileOrigin => ({ kind: 'mod', name });

export const RUNTIME_OUTPUT: FileOrigin = { kind: 'runtimeOutput' };

export const OVERWRITE_LABEL = 'Overwrite';

export const originLabel = (origin: FileOrigin): string => (origin.kind === 'mod' ? origin.name : OVERWRITE_LABEL);

/** A key one origin has and no other. */
export const originKey = (origin: FileOrigin): string => (origin.kind === 'mod' ? `mod/${origin.name}` : origin.kind);

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

function inFileOrderConflict(entry: ConflictEntry | undefined, own: FileOrigin): boolean {
  const providers = entry?.providers ?? [];
  return providers.length > 1 && providers.some((provider) => sameOrigin(provider, own));
}

const winsPath = (entry: ConflictEntry, own: FileOrigin): boolean => sameOrigin(entry.winnerOrigin, own);

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
export class FileConflictLookup<E extends { readonly relativePath: string } = ConflictEntry> {
  private readonly byFoldedPath = new Map<string, E>();

  set(entry: E): void {
    this.byFoldedPath.set(foldPath(entry.relativePath), entry);
  }

  get(relativePath: string): E | undefined {
    return this.byFoldedPath.get(foldPath(relativePath));
  }

  /** Each path once, in the order its winner wins: Overwrite's paths first, then each enabled mod's in mod order. */
  values(): IterableIterator<E> {
    return this.byFoldedPath.values();
  }

  [Symbol.iterator](): IterableIterator<E> {
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
  /** Overwrite, then each enabled mod in mod order, with the files nothing excludes. */
  winningFirst: readonly OriginProvides[];
}

// A later provider loses to the earlier, winning one. A case variant of a path its origin already
// provides is one more name for that origin's copy, never a second provider.
function provide(files: FileConflictLookup, seen: Set<string>, file: OriginFile, origin: FileOrigin): void {
  const folded = foldPath(file.relativePath);
  if (seen.has(folded)) return;
  seen.add(folded);
  const existing = files.get(file.relativePath);
  if (!existing) {
    files.set({ relativePath: file.relativePath, winner: file.sourcePath, winnerOrigin: origin, providers: [origin] });
  } else {
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

  const winningFirst = filesWinningFirst(entries, overwriteFiles, (mod) => filesByMod.get(mod) ?? []);
  for (const { origin, files: provided } of winningFirst) {
    const seen = new Set<string>();
    for (const file of provided) provide(files, seen, file, origin);
  }

  return { files, filesByMod, foldersByMod, winningFirst };
}

const sameEntries = (a: readonly ModlistEntry[], b: readonly ModlistEntry[]): boolean =>
  a.length === b.length && a.every((entry, at) => entry.kind === b.at(at)?.kind && entry.name === b.at(at)?.name && entry.enabled === b.at(at)?.enabled);

interface Built {
  readonly entries: readonly ModlistEntry[];
  readonly overwrite: readonly OriginFile[];
  readonly listings: ReadonlyMap<string, OriginFiles | undefined>;
  readonly index: FileConflictIndex;
}

/** `buildFileConflictIndex`, answering the index it built last while the mods, their order, Overwrite's files and every mod's
 *  listing are the ones it built from. The cost of a refresh then grows with the listings it changed (ADR-0015). */
export function indexReusing(): typeof buildFileConflictIndex {
  let last: Built | undefined;
  return (entries, overwrite, modFiles) => {
    const listings = new Map(entries.flatMap((entry) => (entry.kind === 'mod' ? [[entry.name, modFiles.get(entry.name)] as const] : [])));
    if (last !== undefined && last.overwrite === overwrite && sameEntries(last.entries, entries)
      && [...listings].every(([name, listing]) => last?.listings.get(name) === listing)) return last.index;
    const index = buildFileConflictIndex(entries, overwrite, modFiles);
    last = { entries, overwrite, listings, index };
    return index;
  };
}

/** A file in an archive, by its forward-slash path there, and the release whose format the archive is read as. */
export interface ArchivedFileAddress {
  readonly gameRelease: string;
  readonly archive: string;
  readonly file: string;
}

/** Where the game reads a copy from: a loose file, or a file in an archive. */
export type CopyAt = { readonly kind: 'loose'; readonly path: string } | ({ readonly kind: 'archived' } & ArchivedFileAddress);

export interface StackedCopy {
  readonly origin: FileOrigin;
  readonly at: CopyAt;
}

export interface StackedFile {
  readonly relativePath: string;
  /** One copy from each origin that has one, winning-most first. */
  readonly copies: StackedCopy[];
}

export type StackedCopies = Omit<FileConflictLookup<StackedFile>, 'set'>;

/** Whether `own` has a copy of the file, and another origin has one too. */
export const copyInConflict = (file: StackedFile | undefined, own: FileOrigin): boolean =>
  file !== undefined && file.copies.length > 1 && file.copies.some(({ origin }) => sameOrigin(origin, own));

const LOSING = ['overwrittenLooseFiles', 'archiveOverwrittenByLooseFiles', 'overwrittenByAnotherArchiveFile'] as const;

export interface CopyStanding {
  readonly overwritesLooseFiles: boolean;
  readonly overwrittenLooseFiles: boolean;
  readonly overwritesArchiveWithLooseFiles: boolean;
  readonly archiveOverwrittenByLooseFiles: boolean;
  readonly overwritesAnotherArchiveFile: boolean;
  readonly overwrittenByAnotherArchiveFile: boolean;
  readonly redundant: boolean;
}

interface Tally {
  standing: { -readonly [K in keyof CopyStanding]: boolean };
  gets: boolean;
  loses: boolean;
}

const NO_STANDING: CopyStanding = {
  overwritesLooseFiles: false, overwrittenLooseFiles: false, overwritesArchiveWithLooseFiles: false,
  archiveOverwrittenByLooseFiles: false, overwritesAnotherArchiveFile: false, overwrittenByAnotherArchiveFile: false, redundant: false,
};

function tallyFile({ copies }: StackedFile, tallies: Map<string, Tally>): void {
  const looseTotal = copies.filter(({ at }) => at.kind === 'loose').length;
  const archivedTotal = copies.length - looseTotal;
  let looseOver = 0;
  let archivedOver = 0;
  copies.forEach(({ origin, at }, place) => {
    const key = originKey(origin);
    const tally = tallies.get(key) ?? { standing: { ...NO_STANDING }, gets: false, loses: false };
    tallies.set(key, tally);
    tally.gets ||= place === 0;
    tally.loses ||= place > 0;
    const { standing } = tally;
    if (at.kind === 'loose') {
      standing.overwritesLooseFiles ||= looseTotal - looseOver > 1;
      standing.overwrittenLooseFiles ||= looseOver > 0;
      standing.overwritesArchiveWithLooseFiles ||= archivedTotal > 0;
      looseOver++;
    } else {
      standing.archiveOverwrittenByLooseFiles ||= looseOver > 0;
      standing.overwritesAnotherArchiveFile ||= archivedTotal - archivedOver > 1;
      standing.overwrittenByAnotherArchiveFile ||= archivedOver > 0;
      archivedOver++;
    }
  });
}

function standingsOf(stack: StackedCopies): ReadonlyMap<string, CopyStanding> {
  const tallies = new Map<string, Tally>();
  for (const file of stack) tallyFile(file, tallies);
  return new Map([...tallies].map(([key, { standing, gets, loses }]) => {
    const redundant = loses && !gets;
    return [key, redundant ? { ...standing, ...Object.fromEntries(LOSING.map((id) => [id, false])), redundant } : { ...standing, redundant }];
  }));
}

const standingsOfStack = new WeakMap<StackedCopies, ReadonlyMap<string, CopyStanding>>();

/** Which of mods.md's loose and archive indicators `own` holds over `stack`. The stack is walked once, however many origins ask. */
export function copyStandingOf(stack: StackedCopies, own: FileOrigin): CopyStanding {
  let standings = standingsOfStack.get(stack);
  if (standings === undefined) {
    standings = standingsOf(stack);
    standingsOfStack.set(stack, standings);
  }
  return standings.get(originKey(own)) ?? NO_STANDING;
}

/** An archive the game loads, at the path that wins its name, and what it holds. */
export interface LoadedArchive {
  readonly origin: FileOrigin;
  readonly archive: string;
  readonly files: readonly string[];
}

// The reference tool's FileEntry::sortOrigins (fileentry.cpp): every loose copy wins over every archived one, and of two
// archives the one the game loads later wins.
function add(stack: FileConflictLookup<StackedFile>, relativePath: string, copy: StackedCopy): void {
  const entry = stack.get(relativePath);
  if (entry === undefined) stack.set({ relativePath, copies: [copy] });
  else if (!entry.copies.some(({ origin }) => sameOrigin(origin, copy.origin))) entry.copies.push(copy);
}

/** Each file an enabled mod or Overwrite provides, loose or in an archive in `loaded` (in the order the game loads them),
 *  with its copies as the game stacks them. */
export function stackCopies(index: Pick<FileConflictIndex, 'winningFirst'>, loaded: readonly LoadedArchive[], gameRelease: string): StackedCopies {
  const stack = new FileConflictLookup<StackedFile>();
  for (const { origin, files } of index.winningFirst) for (const file of files) add(stack, file.relativePath, { origin, at: { kind: 'loose', path: file.sourcePath } });
  for (const { origin, archive, files } of [...loaded].reverse()) {
    for (const file of files) add(stack, file, { origin, at: { kind: 'archived', gameRelease, archive, file } });
  }
  return stack;
}

/** The game folder's archived copies by lower-case path, and each Data-folder archive's load rank. The stack holds no game
 *  folder copy (mods-conflicts.md, story 5). */
export interface GameFolderArchived {
  readonly copies: ReadonlyMap<string, ArchivedFileAddress>;
  readonly loadRank: ReadonlyMap<string, number>;
}

export const NO_GAME_FOLDER_ARCHIVED: GameFolderArchived = { copies: new Map(), loadRank: new Map() };

/** `loaded` is every archive the game loads from the Data folder in load order, with what it holds when it is one of the
 *  game folder's and mEdit read it. */
export function gameFolderArchivedOf(loaded: readonly { readonly archive: string; readonly gameFolderFiles?: readonly string[] }[], gameRelease: string): GameFolderArchived {
  const copies = new Map<string, ArchivedFileAddress>();
  for (const { archive, gameFolderFiles = [] } of loaded) {
    for (const file of gameFolderFiles) copies.set(file.toLowerCase(), { gameRelease, archive, file });
  }
  return { copies, loadRank: new Map(loaded.map(({ archive }, rank) => [archive, rank])) };
}

const sameLoaded = (a: readonly LoadedArchive[], b: readonly LoadedArchive[]): boolean =>
  a.length === b.length && a.every((one, at) => {
    const other = b.at(at);
    return other !== undefined && sameOrigin(one.origin, other.origin) && one.archive === other.archive && one.files === other.files;
  });

/** `stackCopies`, answering the stack it built last while the index, the archives loaded and what each holds are the ones
 *  it built from (ADR-0015). */
export function stackReusing(): typeof stackCopies {
  let last: { readonly index: object; readonly loaded: readonly LoadedArchive[]; readonly gameRelease: string; readonly stack: StackedCopies } | undefined;
  return (index, loaded, gameRelease) => {
    if (last !== undefined && last.index === index && last.gameRelease === gameRelease && sameLoaded(last.loaded, loaded)) return last.stack;
    const stack = stackCopies(index, loaded, gameRelease);
    last = { index, loaded, gameRelease, stack };
    return stack;
  };
}

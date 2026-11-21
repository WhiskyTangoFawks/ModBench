// The effective merged mod view — the merge a VFS performs over the Mod override order.

import { pluginCompanionRule } from '../tables/gamePaths';
import type { FileOrigin, ModlistEntry, OriginFile, OriginFiles, OriginFolder, OriginProvides } from '../instanceAdapter/instanceAdapter';
import { originsWinningFirst } from '../symbolNames/symbolNames';
import { sameInputs } from '../ports/lastBuilt';
import { present } from '../ports/present';

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
 *  since a case-variant collision is a filesystem fact rather than a locale one. The game reads
 *  either separator. */
export function foldPath(relativePath: string): string {
  return relativePath.toLowerCase().replaceAll('\\', '/');
}

/** Keyed by folded path, so a case-variant pair resolves to one entry. No raw Map is
 *  exposed: a caller cannot look up with an unfolded path and silently miss. */
export class FileConflictLookup<E extends { readonly relativePath: string } = ConflictEntry> {
  private byFoldedPath = new Map<string, E>();

  set(entry: E): void {
    this.byFoldedPath.set(foldPath(entry.relativePath), entry);
  }

  get(relativePath: string): E | undefined {
    return this.byFoldedPath.get(foldPath(relativePath));
  }

  /** This lookup, with each folded path `changes` names holding the entry it gives, or none where it gives none. */
  changed(changes: ReadonlyMap<string, E | undefined>): FileConflictLookup<E> {
    if (changes.size === 0) return this;
    const next = new FileConflictLookup<E>();
    next.byFoldedPath = new Map(this.byFoldedPath);
    for (const [folded, entry] of changes) {
      if (entry === undefined) next.byFoldedPath.delete(folded);
      else next.byFoldedPath.set(folded, entry);
    }
    return next;
  }

  /** Each path once. */
  values(): IterableIterator<E> {
    return this.byFoldedPath.values();
  }

  [Symbol.iterator](): IterableIterator<E> {
    return this.values();
  }
}

/** The winner lookup minus what builds it.
 *  Every reader of the Instance's `files` field takes this. */
export type FileWinners = Omit<FileConflictLookup, 'set' | 'changed'>;

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

const listingsOf = (entries: readonly ModlistEntry[], modFiles: ReadonlyMap<string, OriginFiles>): [string, OriginFiles][] =>
  entries.flatMap((entry) => {
    if (entry.kind !== 'mod') return [];
    const listing = modFiles.get(entry.name);
    if (listing === undefined) throw new Error(`The reading holds no files for ${entry.name}`);
    return [[entry.name, listing]];
  });

// `was` while every entry is the one it holds.
function mapKeeping<V>(entries: readonly (readonly [string, V])[], was: Map<string, V> | undefined): Map<string, V> {
  return was !== undefined && was.size === entries.length && entries.every(([key, value]) => was.get(key) === value) ? was : new Map(entries);
}

// Overwrite, then each enabled mod in mod order, with the files nothing excludes: `was`'s object for an origin whose files
// are the ones it was built from.
function winningFirstOf(entries: readonly ModlistEntry[], overwrite: readonly OriginFile[], filesByMod: ReadonlyMap<string, readonly OriginFile[]>, was?: readonly OriginProvides[]): OriginProvides[] {
  const kept = new Map((was ?? []).map((provided) => [originKey(provided.origin), provided]));
  return originsWinningFirst(entries).map((origin) => {
    const files = origin.kind === 'mod' ? filesByMod.get(origin.name) ?? [] : overwrite;
    const prior = kept.get(originKey(origin));
    return prior !== undefined && providedFrom.get(prior) === files ? prior : provides(origin, files);
  });
}

const providedFrom = new WeakMap<OriginProvides, readonly OriginFile[]>();

function provides(origin: FileOrigin, files: readonly OriginFile[]): OriginProvides {
  const provided = { origin, files: files.filter((file) => !file.excluded) };
  providedFrom.set(provided, files);
  return provided;
}

const foldedFiles = new WeakMap<OriginProvides, ReadonlyMap<string, OriginFile>>();

// Each path the origin provides, by its folded path, at the first of its case variants.
function foldedFilesOf(provided: OriginProvides): ReadonlyMap<string, OriginFile> {
  let folded = foldedFiles.get(provided);
  if (folded === undefined) {
    const each = new Map<string, OriginFile>();
    for (const file of provided.files) if (!each.has(foldPath(file.relativePath))) each.set(foldPath(file.relativePath), file);
    folded = each;
    foldedFiles.set(provided, folded);
  }
  return folded;
}

// One winning-first order of the origins against the one before it, by `originKey`: `changed` holds each origin whose
// files changed or that only one order holds, and `paths` each folded path those provide or provided.
interface OriginsChanged {
  readonly now: ReadonlyMap<string, OriginProvides>;
  readonly rank: ReadonlyMap<string, number>;
  readonly changed: ReadonlySet<string>;
  readonly paths: ReadonlySet<string>;
}

// None when the origins both orders hold are in another order: then every path may have another winner.

function originsChanged(was: readonly OriginProvides[], now: readonly OriginProvides[]): OriginsChanged | undefined {
  const byKey = (order: readonly OriginProvides[]) => new Map(order.map((provided) => [originKey(provided.origin), provided]));
  const [before, after] = [byKey(was), byKey(now)];
  const kept = (order: readonly OriginProvides[], other: ReadonlyMap<string, OriginProvides>) =>
    order.map(({ origin }) => originKey(origin)).filter((key) => other.has(key));
  if (!sameInputs(kept(was, after), kept(now, before))) return undefined;
  const changed = new Set([...before.keys(), ...after.keys()].filter((key) => before.get(key) !== after.get(key)));
  const paths = new Set([...changed].flatMap((key) => [before.get(key), after.get(key)].flatMap((provided) => (provided === undefined ? [] : [...foldedFilesOf(provided).keys()]))));
  return { now: after, rank: new Map(now.map(({ origin }, at) => [originKey(origin), at])), changed, paths };
}

// The origins that provide the folded path, winning-most first: `kept`, those of them no change touched, and each changed
// origin that provides it now.
function providersOf(folded: string, kept: readonly FileOrigin[], { now, rank, changed }: OriginsChanged): FileOrigin[] {
  const joined = [...changed].flatMap((key) => {
    const provided = now.get(key);
    return provided !== undefined && foldedFilesOf(provided).has(folded) ? [provided.origin] : [];
  });
  const rankOf = (origin: FileOrigin): number => rank.get(originKey(origin)) ?? 0;
  return [...kept.filter((origin) => !changed.has(originKey(origin))), ...joined].sort((a, b) => rankOf(a) - rankOf(b));
}

const sameOrigins = (a: readonly FileOrigin[], b: readonly FileOrigin[]): boolean => a.length === b.length && a.every((origin, at) => {
  const other = b[at];
  return other !== undefined && sameOrigin(origin, other);
});

// The file at the folded path of an origin that provides it now.
const fileAt = ({ now }: OriginsChanged, origin: FileOrigin, folded: string): OriginFile =>
  present(foldedFilesOf(present(now.get(originKey(origin)), 'a provider among the origins')).get(folded), 'the provider\'s file');

function entryAt(folded: string, was: ConflictEntry | undefined, origins: OriginsChanged): ConflictEntry | undefined {
  const providers = providersOf(folded, was?.providers ?? [], origins);
  const [winnerOrigin] = providers;
  if (winnerOrigin === undefined) return undefined;
  const file = fileAt(origins, winnerOrigin, folded);
  const entry = { relativePath: file.relativePath, winner: file.sourcePath, winnerOrigin, providers };
  const same = was !== undefined && was.relativePath === entry.relativePath && was.winner === entry.winner && sameOrigins(was.providers, providers);
  return same ? was : entry;
}

// `was`'s files, with each path the changed origins provide, or provided, provided again.
function filesAgain(was: FileConflictLookup, origins: OriginsChanged): FileConflictLookup {
  const changes = new Map<string, ConflictEntry | undefined>();
  for (const folded of origins.paths) {
    const before = was.get(folded);
    const now = entryAt(folded, before, origins);
    if (now !== before) changes.set(folded, now);
  }
  return was.changed(changes);
}

// From `was`, the index before, each part and entry that is as it was stays `was`'s object, and only the paths of the
// origins that changed are indexed again.
function indexFrom(
  was: FileConflictIndex | undefined, entries: readonly ModlistEntry[], overwriteFiles: readonly OriginFile[], modFiles: ReadonlyMap<string, OriginFiles>,
): FileConflictIndex {
  const listings = listingsOf(entries, modFiles);
  const filesByMod = mapKeeping(listings.map(([name, listing]) => [name, listing.files] as const), was?.filesByMod);
  const foldersByMod = mapKeeping(listings.map(([name, listing]) => [name, listing.folders] as const), was?.foldersByMod);
  const order = winningFirstOf(entries, overwriteFiles, filesByMod, was?.winningFirst);
  const winningFirst = was !== undefined && sameInputs(was.winningFirst, order) ? was.winningFirst : order;
  return { files: filesOf(winningFirst, was), filesByMod, foldersByMod, winningFirst };
}

function filesOf(winningFirst: readonly OriginProvides[], was: FileConflictIndex | undefined): FileConflictLookup {
  if (was?.winningFirst === winningFirst) return was.files;
  const origins = was === undefined ? undefined : originsChanged(was.winningFirst, winningFirst);
  if (was !== undefined && origins !== undefined) return filesAgain(was.files, origins);
  const files = new FileConflictLookup();
  for (const { origin, files: provided } of winningFirst) {
    const seen = new Set<string>();
    for (const file of provided) provide(files, seen, file, origin);
  }
  return files;
}

/** The index of the mods' files and Overwrite's. */
export function buildFileConflictIndex(entries: readonly ModlistEntry[], overwriteFiles: readonly OriginFile[], modFiles: ReadonlyMap<string, OriginFiles>): FileConflictIndex {
  return indexFrom(undefined, entries, overwriteFiles, modFiles);
}

/** `buildFileConflictIndex` from the index it built last, which it answers while nothing it holds changed. */
export function indexReusing(): typeof buildFileConflictIndex {
  let last: FileConflictIndex | undefined;
  return (entries, overwrite, modFiles) => {
    const index = indexFrom(last, entries, overwrite, modFiles);
    if (last === undefined || !sameInputs(Object.values(last), Object.values(index))) last = index;
    return last;
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

export type StackedCopies = Omit<FileConflictLookup<StackedFile>, 'set' | 'changed'>;

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

/** An archive the game loads, at the path that wins its name, and what it holds: nothing known when it cannot be read. */
export interface LoadedArchive {
  readonly origin: FileOrigin;
  readonly archive: string;
  readonly files: readonly string[] | undefined;
}

// The reference tool's FileEntry::sortOrigins (fileentry.cpp): every loose copy wins over every archived one, and of two
// archives the one the game loads later wins.
function add(stack: FileConflictLookup<StackedFile>, relativePath: string, copy: StackedCopy): void {
  const entry = stack.get(relativePath);
  if (entry === undefined) stack.set({ relativePath, copies: [copy] });
  else if (!entry.copies.some(({ origin }) => sameOrigin(origin, copy.origin))) entry.copies.push(copy);
}

type ArchiveRule = (file: OriginFile) => boolean;

// A file an origin provides is a loose copy unless it is an archive in `loaded` the game reads the files of.
function looseIn(loaded: readonly LoadedArchive[], gameRelease: string): ArchiveRule {
  const isArchive = pluginCompanionRule(gameRelease)?.isArchive ?? (() => false);
  const unreadable = new Set(loaded.filter(({ files }) => files === undefined).map(({ archive }) => archive));
  return (file) => !isArchive(file.relativePath) || unreadable.has(file.sourcePath);
}

// Each file the archives in `loaded` (in load order) hold, one copy from each origin, the game's own first.
function archivedCopiesOf(loaded: readonly LoadedArchive[], gameRelease: string): FileConflictLookup<StackedFile> {
  const archived = new FileConflictLookup<StackedFile>();
  for (const { origin, archive, files } of [...loaded].reverse()) {
    for (const file of files ?? []) add(archived, file, { origin, at: { kind: 'archived', gameRelease, archive, file } });
  }
  return archived;
}

function stackOf(winningFirst: readonly OriginProvides[], isLoose: ArchiveRule, archived: FileConflictLookup<StackedFile>): FileConflictLookup<StackedFile> {
  const stack = new FileConflictLookup<StackedFile>();
  for (const { origin, files } of winningFirst) for (const file of files) if (isLoose(file)) add(stack, file.relativePath, { origin, at: { kind: 'loose', path: file.sourcePath } });
  for (const { relativePath, copies } of archived) for (const copy of copies) add(stack, relativePath, copy);
  return stack;
}

/** Each file a mod or Overwrite provides, loose or in an archive in `loaded` (in load order), as the game stacks its
 *  copies. An archive is the files it holds: one not loaded gives none, one unreadable stays a file. */
export function stackCopies(index: Pick<FileConflictIndex, 'winningFirst'>, loaded: readonly LoadedArchive[], gameRelease: string): StackedCopies {
  return stackOf(index.winningFirst, looseIn(loaded, gameRelease), archivedCopiesOf(loaded, gameRelease));
}

// The copies of the folded path: `was`'s from each origin no change touched, and each changed origin's now.
function stackedAt(folded: string, was: StackedFile | undefined, origins: OriginsChanged, isLoose: ArchiveRule, archived: FileConflictLookup<StackedFile>): StackedFile | undefined {
  const wasLoose = (was?.copies ?? []).filter(({ at }) => at.kind === 'loose');
  const loose = providersOf(folded, wasLoose.map(({ origin }) => origin), origins).flatMap((origin): StackedCopy[] => {
    const kept = wasLoose.find((copy) => sameOrigin(copy.origin, origin));
    if (kept !== undefined && !origins.changed.has(originKey(origin))) return [kept];
    const file = fileAt(origins, origin, folded);
    return isLoose(file) ? [{ origin, at: { kind: 'loose', path: file.sourcePath } }] : [];
  });
  const inArchives = archived.get(folded);
  if (inArchives === undefined && loose.length === 0) return undefined;
  const copies = [...loose, ...(inArchives?.copies ?? []).filter((copy) => !loose.some(({ origin }) => sameOrigin(origin, copy.origin)))];
  const relativePath = relativePathOf(folded, loose, inArchives, was, origins);
  return was !== undefined && was.relativePath === relativePath && sameInputs(was.copies, copies) ? was : { relativePath, copies };
}

// The winning loose copy's own spelling, else the first archive's that holds it.
function relativePathOf(folded: string, loose: readonly StackedCopy[], inArchives: StackedFile | undefined, was: StackedFile | undefined, origins: OriginsChanged): string {
  const [first] = loose;
  if (first === undefined) return present(inArchives, 'an archived copy').relativePath;
  return was?.copies[0] === first ? was.relativePath : fileAt(origins, first.origin, folded).relativePath;
}

function restacked(was: FileConflictLookup<StackedFile>, origins: OriginsChanged, isLoose: ArchiveRule, archived: FileConflictLookup<StackedFile>): FileConflictLookup<StackedFile> {
  const changes = new Map<string, StackedFile | undefined>();
  for (const folded of origins.paths) {
    const before = was.get(folded);
    const now = stackedAt(folded, before, origins, isLoose, archived);
    if (now !== before) changes.set(folded, now);
  }
  return was.changed(changes);
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

interface Stacked {
  readonly winningFirst: readonly OriginProvides[];
  readonly loaded: readonly LoadedArchive[];
  readonly gameRelease: string;
  readonly archived: FileConflictLookup<StackedFile>;
  readonly stack: FileConflictLookup<StackedFile>;
}

function stackAgain(was: Stacked | undefined, winningFirst: readonly OriginProvides[], isLoose: ArchiveRule, archived: FileConflictLookup<StackedFile>): FileConflictLookup<StackedFile> {
  const origins = was === undefined ? undefined : originsChanged(was.winningFirst, winningFirst);
  return was === undefined || origins === undefined ? stackOf(winningFirst, isLoose, archived) : restacked(was.stack, origins, isLoose, archived);
}

/** `stackCopies`, from the stack it built last: while the archives loaded and what each holds are the same, a change
 *  costs the paths of the origins it changed. */
export function stackReusing(): typeof stackCopies {
  let last: Stacked | undefined;
  return ({ winningFirst }, loaded, gameRelease) => {
    const was = last?.gameRelease === gameRelease && sameLoaded(last.loaded, loaded) ? last : undefined;
    if (was?.winningFirst === winningFirst) return was.stack;
    const archived = was?.archived ?? archivedCopiesOf(loaded, gameRelease);
    const stack = stackAgain(was, winningFirst, looseIn(loaded, gameRelease), archived);
    last = { winningFirst, loaded, gameRelease, archived, stack };
    return stack;
  };
}

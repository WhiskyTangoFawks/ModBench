// target-architecture.d2's Mod status; the mod-status trace.

import { basename } from 'node:path';
import type { EntryRef, GameFolder, InstanceAdapter, ModFolder, Reread } from '../instanceAdapter/instanceAdapter';
import { pathKey } from '../repositoriesLib/stampedReads';
import { changedKeys } from '../ports/lastBuilt';
import {
  buildFileAgainst, filesAPackageHolds, flaggedFilesIn, flaggedHashesFrom, heldWholeStatus, isManifestPath, manifestAt, packageFilesOf, packagesAskedAt, statusFrom, unreadableStatus, type FlaggedRead, type ModAt, type ModStatus,
} from '../manifestAdapter/manifestAdapter';
import { entriesNoPackageHolds, type ArchiveEntries, type EntriesNoPackageHolds, type HashEntries } from './archiveEntries';

export type { HashEntries };

/** What a status is derived from in an instance value. */
export interface StatusSource {
  readonly holdsRepository: boolean;
  /** What mEdit says each flagged plugin could have held before its flags, by the path it is read from. */
  readonly flaggedHashes: ReadonlyMap<string, FlaggedRead>;
  readonly mods: readonly EntryRef[];
  readonly modFolders: readonly ModFolder[] | undefined;
  readonly entryKey: (entry: EntryRef) => string;
  /** Each source mod's source folder, by its entry's name, and the downloads folder an installation file is in. */
  readonly paths: { readonly sourceDirs: ReadonlyMap<string, string>; readonly downloadsDir: string | undefined };
  /** What each archive at the root of a listed mod holds, by the path it is read from. */
  readonly archiveContents: ReadonlyMap<string, ArchiveEntries>;
  readonly gameName: string;
  /** Each listed mod's own files, by its entry's name: what the reading already holds. */
  readonly filesByMod: ReadonlyMap<string, readonly { readonly relativePath: string; readonly sourcePath: string }[]>;
  /** Where a package of the game folder is read. */
  readonly gameFolder: GameFolder;
}

/** The facts a status is derived from. */
export const STATUS_READS = {
  holdsRepository: true, flaggedHashes: true, mods: true, modFolders: true, entryKey: true, paths: true, archiveContents: true, gameName: true, filesByMod: true,
  gameFolder: true,
} as const satisfies Record<keyof StatusSource, true>;

const isStatusFact = (key: string): key is keyof StatusSource => key in STATUS_READS;

type StatusChange = Reread & { readonly before: StatusSource };

// Keyed by a mod's entry or by a file it holds, so each is compared entry by entry: what changed of one mod touches it alone.
const BY_ENTRY: ReadonlySet<keyof StatusSource> = new Set(['filesByMod', 'archiveContents', 'flaggedHashes']);

// The mods the files `named` and the facts keyed per entry touch; every mod where one is in no one mod's.
function touchedAmong(value: StatusSource, before: StatusSource, named: readonly string[], folders: Folders): Touched {
  const touched = new Set(changedKeys(value.filesByMod, before.filesByMod).flatMap((entry) => folders.byEntry.get(entry)?.name ?? []));
  const inFolders = (path: string): string[] => [...foldersAbove(path)].flatMap((folder) => folders.owners.get(folder) ?? []);
  // An archive or a flagged plugin is keyed by the path it is read from, which a link puts outside its mod's folder.
  let linked: ReadonlyMap<string, readonly string[]> | undefined;
  const holding = (path: string): readonly string[] => {
    const inFolder = inFolders(path);
    return inFolder.length > 0 ? inFolder : (linked ??= modsHolding(value, folders.placed)).get(path) ?? [];
  };
  const readAgain = [...changedKeys(value.archiveContents, before.archiveContents), ...changedKeys(value.flaggedHashes, before.flaggedHashes)];
  const placed = placedIn(named.filter((path) => readsIn(folders, path)), inFolders, touched) && placedIn(readAgain, holding, touched);
  return placed ? touched : 'every';
}

// Adds to `touched` the mods each of `paths` belongs to; false at the first that belongs to none.
function placedIn(paths: readonly string[], ownersOf: (path: string) => readonly string[], touched: Set<string>): boolean {
  for (const path of paths) {
    const owners = ownersOf(path);
    if (owners.length === 0) return false;
    for (const name of owners) touched.add(name);
  }
  return true;
}

// The mods that hold each file, by the path it is read from.
function modsHolding(value: StatusSource, mods: readonly ModPlaced[]): ReadonlyMap<string, readonly string[]> {
  const holding = new Map<string, string[]>();
  for (const { entry, name } of mods) {
    for (const { sourcePath } of value.filesByMod.get(entry) ?? []) holding.set(sourcePath, [...holding.get(sourcePath) ?? [], name]);
  }
  return holding;
}

const separator = (): string => (process.platform === 'win32' ? '\\' : '/');

// A folder as `pathKey` names it, with Windows's either separator as one.
const folderKey = (path: string): string => {
  const key = process.platform === 'win32' ? pathKey(path).replaceAll('/', '\\') : path;
  return key.length > 1 && key.endsWith(separator()) ? key.slice(0, -1) : key;
};

// `path`, then each folder above it.
function* foldersAbove(path: string): Generator<string> {
  for (let at = folderKey(path); ; ) {
    yield at;
    const cut = at.lastIndexOf(separator());
    if (cut <= 0) return;
    at = at.slice(0, cut);
  }
}

// The folders a status reads, by key, and the listed mods each holds. Built again only when a fact it is built from is another
// object, so a path is placed by its folders whatever the modlist's size.
interface Folders {
  readonly placed: readonly ModPlaced[];
  readonly byName: ReadonlyMap<string, ModPlaced>;
  readonly byEntry: ReadonlyMap<string, ModPlaced>;
  readonly owners: ReadonlyMap<string, readonly string[]>;
  readonly read: ReadonlySet<string>;
}

// The facts the folders a status reads are built from.
const foldersFrom = (value: StatusSource): readonly unknown[] => [value.mods, value.modFolders, value.entryKey, value.paths, value.gameFolder];

function foldersIn(value: StatusSource): Folders {
  const placed = placedAt(value);
  const owners = new Map<string, string[]>();
  for (const { name, folder, sourceFolder } of placed) {
    for (const key of [folder, ...sourceFolder === undefined ? [] : [sourceFolder]].map(folderKey)) owners.set(key, [...owners.get(key) ?? [], name]);
  }
  const read = new Set([
    ...(value.modFolders ?? []).map((folder) => folder.path), ...value.paths.sourceDirs.values(),
    ...value.paths.downloadsDir === undefined ? [] : [value.paths.downloadsDir], ...value.gameFolder.kind === 'found' ? [value.gameFolder.root] : [],
  ].map(folderKey));
  return { placed, byName: new Map(placed.map((mod) => [mod.name, mod])), byEntry: new Map(placed.map((mod) => [mod.entry, mod])), owners, read };
}

// git answers which files of a folder it holds, and the repository's change names its .git.
const isRepository = (path: string): boolean => /[\\/]\.git$/.test(path);

function readsIn({ read }: Folders, path: string): boolean {
  if (isRepository(path)) return true;
  for (const folder of foldersAbove(path)) if (read.has(folder)) return true;
  return false;
}

const isGitsOwn = (path: string): boolean => path === '.git' || path.startsWith('.git/');

type Asked = ReturnType<typeof packagesAskedAt>;

type ModPlaced = ModAt & { readonly entry: string; readonly sourceFolder?: string };

type ModAndSourceFolder = ModPlaced & { readonly files: readonly string[]; readonly sourcePaths: ReadonlyMap<string, string> };

interface Listening {
  dispose(): void;
}

// Where each listed mod is, with no file of it read: what a change is placed against.
function placedAt(value: StatusSource): ModPlaced[] {
  const keyOf = (entry: EntryRef): string => `${entry.kind}:${value.entryKey(entry)}`;
  const folders = new Map((value.modFolders ?? []).map((folder) => [keyOf(folder), folder]));
  return value.mods.filter(({ kind }) => kind === 'mod').flatMap((entry) => {
    const folder = folders.get(keyOf(entry));
    return folder === undefined ? [] : [{ name: folder.modName, entry: entry.name, folder: folder.path, sourceFolder: value.paths.sourceDirs.get(entry.name) }];
  });
}

function withFiles(value: StatusSource, mod: ModPlaced): ModAndSourceFolder {
  const files = value.filesByMod.get(mod.entry) ?? [];
  return { ...mod, files: files.map(({ relativePath }) => relativePath), sourcePaths: new Map(files.map(({ relativePath, sourcePath }) => [relativePath, sourcePath])) };
}

// The installation files and game files of both: the packages of a source mod's source folder are read in the one pass over its folder.
const askedBoth = (own: Asked, other: Asked): Asked => {
  if (own === undefined || other === undefined) return own ?? other;
  const gameFiles = own.gameFiles === undefined && other.gameFiles === undefined ? undefined : [...new Set([...own.gameFiles ?? [], ...other.gameFiles ?? []])];
  return { ...own, installationFiles: [...new Set([...own.installationFiles, ...other.installationFiles])], ...gameFiles === undefined ? {} : { gameFiles } };
};

type ManifestRead = Awaited<ReturnType<typeof manifestAt>>;
type Values = Awaited<ReturnType<InstanceAdapter['modValue']>>;

function judged(mod: ModAt, manifest: ManifestRead, values: Values, flagged: StatusSource['flaggedHashes'], sourcePaths: ReadonlyMap<string, string>): ModStatus {
  if (manifest.read === undefined || !('manifest' in manifest.read) || values.kind !== 'read') return statusFrom(mod, manifest, values, new Map());
  const hashes = flaggedHashesFrom(flaggedFilesIn(manifest.read.manifest, values.folder, mod.folder), ({ pathInFolder, file }) => flagged.get(sourcePaths.get(pathInFolder) ?? file.path));
  return 'cannotTell' in hashes ? unreadableStatus(mod.name, `mEdit could not say what its flagged plugins held before their flags: ${hashes.cannotTell}`) : statusFrom(mod, manifest, values, hashes);
}

type Installed = Awaited<ReturnType<InstanceAdapter['installationFile']>>;

const heldSnapshot = (held: ReadonlyMap<string, ReadonlySet<string>>, entries: ReadonlyMap<string, ReadonlyMap<string, EntriesNoPackageHolds>>): string =>
  JSON.stringify([[...held].map(([mod, paths]) => [mod, [...paths].sort()]), [...entries].map(([mod, archives]) => [mod, [...archives]])]);

type Derived = { status: ModStatus; packaged: ReadonlySet<string>; entries: ReadonlyMap<string, EntriesNoPackageHolds> };

// The mods a derivation derives again, by name: every one, or those a change touched.
type Touched = 'every' | ReadonlySet<string>;

const bothTouched = (one: Touched, other: Touched): Touched => (one === 'every' || other === 'every' ? 'every' : new Set([...one, ...other]));

// The mods whose statuses read otherwise in the two.
const statusesChanged = (before: ReadonlyMap<string, ModStatus>, after: ReadonlyMap<string, ModStatus>): Set<string> =>
  new Set([...before.keys(), ...after.keys()].filter((mod) => before.get(mod) !== after.get(mod) && JSON.stringify(before.get(mod)) !== JSON.stringify(after.get(mod))));

const listenedBy = <L>(listeners: Set<L>, listener: L): Listening => {
  listeners.add(listener);
  return { dispose: () => { listeners.delete(listener); } };
};

/** Each mod's status, derived from the latest instance value while the instance holds a repository. An unreadable
 *  status keeps the last good one shown, and says why on the message line and once in the Output (common.md, Reporting). */
export class ModStatuses {
  private derived: ReadonlyMap<string, ModStatus> = new Map();
  private heldByPackages: ReadonlyMap<string, ReadonlySet<string>> = new Map();
  private entriesByMod: ReadonlyMap<string, ReadonlyMap<string, EntriesNoPackageHolds>> = new Map();
  private readonly shown = new Map<string, ModStatus>();
  private readonly unreadable = new Map<string, string>();
  private gitFailure: string | undefined;
  private waiting: { value: StatusSource; touched: Touched } | undefined;
  // A derivation failed, so the next derives every mod, those it would have derived among them.
  private failedLast = false;
  private indexed: { readonly from: readonly unknown[]; readonly folders: Folders } | undefined;
  private deriving = false;
  private started = 0;
  private finished = 0;
  private failure: Error | undefined;
  private readonly finishedRun: (() => void)[] = [];
  private readonly changed = new Set<(mods: 'every' | ReadonlySet<string>) => void>();
  private readonly messageChanged = new Set<() => void>();

  constructor(private readonly reads: Pick<InstanceAdapter, 'modValue' | 'installationFile' | 'foldersHeldWhole' | 'filesHeldByGit'>, private readonly log: (line: string) => void, private readonly hashEntries: HashEntries) {}

  /** Derives again from `value` the status of each mod `changed` touches, and every mod's without it; of the values handed
   *  while one derives, the latest alone derives next, the mods each touched. */
  derive(value: StatusSource, changed?: StatusChange): void {
    const touched = this.touchedBy(value, changed);
    this.waiting = { value, touched: this.waiting === undefined ? touched : bothTouched(this.waiting.touched, touched) };
    if (this.deriving) return;
    this.deriving = true;
    void this.deriveWhileWaiting();
  }

  /** The statuses derived from the value current when asked: the derivation under way, or the next when a newer value waits
   *  behind it. Values arriving meanwhile do not hold it. Rejects with why the last derivation failed. */
  async current(): Promise<ReadonlyMap<string, ModStatus>> {
    const settledRun = this.waiting === undefined ? this.started : this.started + 1;
    while (this.finished < settledRun) await new Promise<void>((resolve) => { this.finishedRun.push(resolve); });
    if (this.failure !== undefined) throw this.failure;
    return this.derived;
  }

  /** The files of the mod's folder that a package holds, by bytes or by name, as the latest derivation read: its source
   *  folder's manifest's for a source mod, else its folder's, and its installation file's. */
  heldByPackage(mod: string): ReadonlySet<string> {
    return this.heldByPackages.get(mod) ?? new Set();
  }

  /** The entries of each archive of the mod's folder, by its path there, that no package holds, as the latest derivation read;
   *  an archive a package holds whole, and a file that is no archive, has none. */
  entriesNoPackageHolds(mod: string): ReadonlyMap<string, EntriesNoPackageHolds> {
    return this.entriesByMod.get(mod) ?? new Map();
  }

  /** The mod's last good status. */
  of(mod: string): ModStatus | undefined {
    return this.shown.get(mod);
  }

  /** Calls `listener` with the mods whose statuses changed, or `'every'`. */
  onDidChange(listener: (mods: 'every' | ReadonlySet<string>) => void): Listening {
    return listenedBy(this.changed, listener);
  }

  /** Why the statuses shown are the last good ones (common.md, States, story 6). */
  lastGoodReasons(): string[] {
    if (this.gitFailure !== undefined) return this.shown.size === 0 ? [] : [this.gitWhy(this.gitFailure)];
    return [...this.unreadable].map(([mod, why]) => `the status of "${mod}" could not be read: ${why}.`);
  }

  /** Why no status could be read (common.md, States, story 2). */
  unreadMessage(): string | undefined {
    return this.gitFailure !== undefined && this.shown.size === 0 ? `The statuses could not be read: ${this.gitWhy(this.gitFailure)}` : undefined;
  }

  private gitWhy(failure: string): string {
    return `git could not say which folders it holds: ${failure}.`;
  }

  onMessageChanged(listener: () => void): Listening {
    return listenedBy(this.messageChanged, listener);
  }

  dispose(): void {
    this.changed.clear();
    this.messageChanged.clear();
  }

  // A change touches every mod when it is a check of the disk, changes a fact of every mod, or names a file it reads that no one
  // mod holds.
  private touchedBy(value: StatusSource, changed: StatusChange | undefined): Touched {
    if (changed === undefined || changed.disk) return 'every';
    const { before } = changed;
    if (Object.keys(STATUS_READS).filter(isStatusFact).some((fact) => !BY_ENTRY.has(fact) && value[fact] !== before[fact])) return 'every';
    return touchedAmong(value, before, changed.named, this.foldersOf(value));
  }

  /** Whether a status reads the file at `path`: in a mod's folder or source folder, an installation file, a game file, or what
   *  git holds. */
  readsFile(path: string, value: StatusSource): boolean {
    return readsIn(this.foldersOf(value), path);
  }

  private foldersOf(value: StatusSource): Folders {
    const from = foldersFrom(value);
    if (this.indexed === undefined || this.indexed.from.some((fact, at) => fact !== from[at])) this.indexed = { from, folders: foldersIn(value) };
    return this.indexed.folders;
  }

  private async deriveWhileWaiting(): Promise<void> {
    for (let waiting = this.waiting; waiting !== undefined; waiting = this.waiting) {
      this.waiting = undefined;
      this.started += 1;
      const touched = this.failedLast ? 'every' : waiting.touched;
      this.failedLast = false;
      try {
        await this.deriveFrom(waiting.value, touched);
        this.failure = undefined;
      } catch (err) {
        this.failure = err instanceof Error ? err : new Error(String(err));
        this.failedLast = true;
      }
      this.finished += 1;
      for (const resolve of this.finishedRun.splice(0)) resolve();
    }
    this.deriving = false;
  }

  private async deriveFrom(value: StatusSource, touched: Touched): Promise<void> {
    const folders = this.foldersOf(value);
    const listed = value.holdsRepository ? folders.placed : [];
    const mods = (touched === 'every' || listed.length === 0 ? listed : [...touched].flatMap((name) => folders.byName.get(name) ?? [])).map((mod) => withFiles(value, mod));
    const held = await this.heldAmong(mods);
    if (held === undefined) {
      this.derived = new Map(listed.map(({ name }) => [name, unreadableStatus(name, `git could not say which folders it holds: ${this.gitFailure}`)]));
      this.failedLast = true;
      for (const listener of this.changed) listener('every');
      return;
    }
    const derived = await Promise.all(mods.map((mod) => this.statusOf(mod, held.whole.has(mod.folder), (held.files.get(mod.folder) ?? []).filter((path) => !isManifestPath(path)), value)));
    const kept = <T>(before: ReadonlyMap<string, T>): Map<string, T> => new Map(touched === 'every' ? [] : before);
    const heldBefore = heldSnapshot(this.heldByPackages, this.entriesByMod);
    this.heldByPackages = new Map([...kept(this.heldByPackages), ...derived.map(({ status, packaged }) => [status.mod, packaged] as const)]);
    this.entriesByMod = new Map([...kept(this.entriesByMod), ...derived.map(({ status, entries }) => [status.mod, entries] as const)]);
    const heldChanged = heldSnapshot(this.heldByPackages, this.entriesByMod) !== heldBefore;
    this.hold(new Map([...kept(this.derived), ...derived.map(({ status }) => [status.mod, status] as const)]), heldChanged);
  }

  // Git failing leaves the last good statuses shown, and says why once for all of them.
  private setGitFailure(why: string | undefined): void {
    if (this.gitFailure === why) return;
    this.gitFailure = why;
    if (why !== undefined) this.log(`[modList] Git could not say which folders it holds: ${why}`);
    for (const listener of this.messageChanged) listener();
  }

  private async heldAmong(mods: readonly ModAt[]): Promise<{ whole: ReadonlySet<string>; files: ReadonlyMap<string, readonly string[]> } | undefined> {
    const folders = mods.map(({ folder }) => folder);
    try {
      const [whole, files] = await Promise.all([this.reads.foldersHeldWhole(folders), this.reads.filesHeldByGit(folders)]);
      this.setGitFailure(undefined);
      return { whole, files };
    } catch (err) {
      this.setGitFailure(err instanceof Error ? err.message : String(err));
      return undefined;
    }
  }

  private async statusAgainstManifest(mod: ModAndSourceFolder, heldByGit: readonly string[], value: StatusSource, installation: Promise<Installed>): Promise<Derived> {
    const manifest = await manifestAt(mod.folder);
    const named = mod.sourceFolder === undefined ? manifest : await manifestAt(mod.sourceFolder);
    const values = await this.reads.modValue(mod.folder, askedBoth(packagesAskedAt(manifest), packagesAskedAt(named)), heldByGit);
    const status = judged(mod, manifest, values, value.flaggedHashes, mod.sourcePaths);
    if (status.unreadable !== undefined) return { status, packaged: new Set(), entries: new Map() };
    const unpackaged = status.noManifest ? mod.files.filter((path) => !isGitsOwn(path)) : status.unpackaged;
    const installed = await installation;
    const installationFile = installed.kind === 'read' && installed.answer !== undefined ? { name: basename(installed.answer.path), entries: installed.answer.entries } : undefined;
    const packaging = named.read !== undefined && 'manifest' in named.read ? named.read.manifest : undefined;
    const packageFiles = packaging === undefined ? [] : packageFilesOf(packaging, values, installationFile);
    const packaged = filesAPackageHolds(packageFiles, values);
    const unpackagedPaths = [...new Set([...unpackaged, ...heldByGit])].sort();
    const archives = unpackagedPaths.filter((path) => !packaged.has(path)).flatMap((path) => {
      const sourcePath = mod.sourcePaths.get(path) ?? '';
      const contents = value.archiveContents.get(sourcePath);
      return contents === undefined ? [] : [{ path, sourcePath, contents }];
    });
    const unanswered = packageFiles.length === 0 ? undefined : archives.find(({ contents }) => contents.kind === 'unanswered');
    if (unanswered !== undefined) return { status: unreadableStatus(mod.name, `mEdit has not said what '${unanswered.path}' holds`), packaged: new Set(), entries: new Map() };
    const answered = archives.flatMap(({ path, sourcePath, contents }) => (contents.kind === 'unanswered' ? [] : [{ path, sourcePath, contents }]));
    const entries = new Map(await Promise.all(answered.map(async ({ path, sourcePath, contents }) =>
      [path, await entriesNoPackageHolds(value.gameName, sourcePath, contents, packageFiles, this.hashEntries)] as const)));
    return { status: { ...status, unpackaged: unpackagedPaths }, packaged, entries };
  }

  // The installation file is the mod manager's record, so a folder git holds whole is warned of it too.
  private async statusOf(mod: ModAndSourceFolder, heldWhole: boolean, heldByGit: readonly string[], value: StatusSource): Promise<Derived> {
    const installation = this.reads.installationFile(mod.name, mod.folder);
    const [{ status, packaged, entries }, installed, buildFile] = await Promise.all([
      heldWhole ? { status: heldWholeStatus(mod.name, heldByGit), packaged: new Set<string>(), entries: new Map() } : this.statusAgainstManifest(mod, heldByGit, value, installation), installation,
      mod.sourceFolder === undefined ? undefined : buildFileAgainst(mod.sourceFolder),
    ]);
    return { status: { ...status, ...installed.kind === 'unreadable' ? { installationFileProblem: installed.reason } : {}, ...buildFile && { buildFile } }, packaged, entries };
  }

  private hold(derived: ReadonlyMap<string, ModStatus>, heldChanged: boolean): void {
    const changed = statusesChanged(this.derived, derived);
    this.derived = derived;
    if (changed.size > 0) this.show(derived);
    if (changed.size > 0 || heldChanged) for (const listener of this.changed) listener(heldChanged ? 'every' : changed);
    if (changed.size > 0) for (const listener of this.messageChanged) listener();
  }

  // A status read stands for the mod's last good one; one that could not be read is told once.
  private show(derived: ReadonlyMap<string, ModStatus>): void {
    for (const mod of [...this.shown.keys(), ...this.unreadable.keys()].filter((held) => !derived.has(held))) {
      this.shown.delete(mod);
      this.unreadable.delete(mod);
    }
    for (const status of derived.values()) {
      if (status.unreadable === undefined) {
        this.unreadable.delete(status.mod);
        this.shown.set(status.mod, status);
        continue;
      }
      if (this.unreadable.get(status.mod) !== status.unreadable) this.log(`[modList] The status of "${status.mod}" could not be read: ${status.unreadable}`);
      this.unreadable.set(status.mod, status.unreadable);
    }
  }
}

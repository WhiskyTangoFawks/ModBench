// target-architecture.d2's Mod status; the mod-status trace.

import type { EntryRef, InstanceAdapter, ModFolder } from '../instanceAdapter/instanceAdapter';
import {
  buildFileAgainst, filesAPackageHolds, flaggedFilesIn, flaggedHashesFrom, heldWholeStatus, manifestAt, packagesAskedAt, statusFrom, unreadableStatus, type FlaggedRead, type ModAt, type ModStatus,
} from '../manifestAdapter/manifestAdapter';

/** What a status is derived from in an instance value. */
export interface StatusSource {
  readonly holdsRepository: boolean;
  /** What mEdit says each flagged plugin could have held before its flags, by the path it is read from. */
  readonly flaggedHashes: ReadonlyMap<string, FlaggedRead>;
  readonly mods: readonly EntryRef[];
  readonly modFolders: readonly ModFolder[] | undefined;
  readonly entryKey: (entry: EntryRef) => string;
  /** Each source mod's source folder, by its entry's name. */
  readonly paths: { readonly sourceDirs: ReadonlyMap<string, string> };
  /** Each listed mod's own files, by its entry's name: what the reading already holds. */
  readonly filesByMod: ReadonlyMap<string, readonly { readonly relativePath: string }[]>;
}

const isGitsOwn = (path: string): boolean => path === '.git' || path.startsWith('.git/');

type Asked = ReturnType<typeof packagesAskedAt>;

type ModAndSourceFolder = ModAt & { readonly sourceFolder?: string; readonly files: readonly string[] };

interface Listening {
  dispose(): void;
}

function modsAt(value: StatusSource): ModAndSourceFolder[] {
  const keyOf = (entry: EntryRef): string => `${entry.kind}:${value.entryKey(entry)}`;
  const folders = new Map((value.modFolders ?? []).map((folder) => [keyOf(folder), folder]));
  return value.mods.filter(({ kind }) => kind === 'mod').flatMap((entry) => {
    const folder = folders.get(keyOf(entry));
    return folder === undefined ? [] : [{ name: folder.modName, folder: folder.path, sourceFolder: value.paths.sourceDirs.get(entry.name), files: (value.filesByMod.get(entry.name) ?? []).map(({ relativePath }) => relativePath) }];
  });
}

// The installation files and game files of both: the packages of a source mod's source folder are read in the one pass over its folder.
const askedBoth = (own: Asked, other: Asked): Asked => {
  if (own === undefined || other === undefined) return own ?? other;
  const gameFiles = own.gameFiles === undefined && other.gameFiles === undefined ? undefined : [...new Set([...own.gameFiles ?? [], ...other.gameFiles ?? []])];
  return { ...own, installationFiles: [...new Set([...own.installationFiles, ...other.installationFiles])], ...gameFiles === undefined ? {} : { gameFiles } };
};

type ManifestRead = Awaited<ReturnType<typeof manifestAt>>;
type Values = Awaited<ReturnType<InstanceAdapter['modValue']>>;

function judged(mod: ModAt, manifest: ManifestRead, values: Values, flagged: StatusSource['flaggedHashes']): ModStatus {
  if (manifest.read === undefined || !('manifest' in manifest.read) || values.kind !== 'read') return statusFrom(mod, manifest, values, new Map());
  const hashes = flaggedHashesFrom(flaggedFilesIn(manifest.read.manifest, values.folder, mod.folder), (path) => flagged.get(path));
  return 'cannotTell' in hashes ? unreadableStatus(mod.name, `mEdit could not say what its flagged plugins held before their flags: ${hashes.cannotTell}`) : statusFrom(mod, manifest, values, hashes);
}

const heldSnapshot = (held: ReadonlyMap<string, ReadonlySet<string>>): string => JSON.stringify([...held].map(([mod, paths]) => [mod, [...paths].sort()]));

const listenedBy = (listeners: Set<() => void>, listener: () => void): Listening => {
  listeners.add(listener);
  return { dispose: () => { listeners.delete(listener); } };
};

/** Each mod's status, derived from the latest instance value while the instance holds a repository. An unreadable
 *  status keeps the last good one shown, and says why on the message line and once in the Output (common.md, Reporting). */
export class ModStatuses {
  private derived: ReadonlyMap<string, ModStatus> = new Map();
  private heldByPackages: ReadonlyMap<string, ReadonlySet<string>> = new Map();
  private readonly shown = new Map<string, ModStatus>();
  private readonly unreadable = new Map<string, string>();
  private gitFailure: string | undefined;
  private waiting: StatusSource | undefined;
  private deriving = false;
  private started = 0;
  private finished = 0;
  private failure: Error | undefined;
  private readonly finishedRun: (() => void)[] = [];
  private readonly changed = new Set<() => void>();
  private readonly messageChanged = new Set<() => void>();

  constructor(private readonly reads: Pick<InstanceAdapter, 'modValue' | 'installationFile' | 'foldersHeldWhole' | 'filesHeldByGit'>, private readonly log: (line: string) => void) {}

  /** Derives every status again from `value`; of the values handed while one derives, the latest alone derives next. */
  derive(value: StatusSource): void {
    this.waiting = value;
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

  /** The files of the mod's folder that one of its packages holds, by bytes or by name, as the latest derivation read them:
   *  those of its source folder's manifest for a source mod, else of its folder's. */
  heldByPackage(mod: string): ReadonlySet<string> {
    return this.heldByPackages.get(mod) ?? new Set();
  }

  /** The mod's last good status. */
  of(mod: string): ModStatus | undefined {
    return this.shown.get(mod);
  }

  onDidChange(listener: () => void): Listening {
    return listenedBy(this.changed, listener);
  }

  message(): string | undefined {
    if (this.gitFailure !== undefined) {
      const why = `git could not say which folders it holds: ${this.gitFailure}.`;
      return this.shown.size === 0 ? `The statuses could not be read: ${why}` : `Showing the last good read: ${why}`;
    }
    if (this.unreadable.size === 0) return undefined;
    return `Showing the last good read: ${[...this.unreadable].map(([mod, why]) => `the status of "${mod}" could not be read: ${why}.`).join(' ')}`;
  }

  onMessageChanged(listener: () => void): Listening {
    return listenedBy(this.messageChanged, listener);
  }

  dispose(): void {
    this.changed.clear();
    this.messageChanged.clear();
  }

  private async deriveWhileWaiting(): Promise<void> {
    for (let value = this.waiting; value !== undefined; value = this.waiting) {
      this.waiting = undefined;
      this.started += 1;
      try {
        await this.deriveFrom(value);
        this.failure = undefined;
      } catch (err) {
        this.failure = err instanceof Error ? err : new Error(String(err));
      }
      this.finished += 1;
      for (const resolve of this.finishedRun.splice(0)) resolve();
    }
    this.deriving = false;
  }

  private async deriveFrom(value: StatusSource): Promise<void> {
    const mods = value.holdsRepository ? modsAt(value) : [];
    const held = await this.heldAmong(mods);
    if (held === undefined) {
      this.derived = new Map(mods.map(({ name }) => [name, unreadableStatus(name, `git could not say which folders it holds: ${this.gitFailure}`)]));
      for (const listener of this.changed) listener();
      return;
    }
    const derived = await Promise.all(mods.map((mod) => this.statusOf(mod, held.whole.has(mod.folder), held.files.get(mod.folder) ?? [], value.flaggedHashes)));
    const heldBefore = heldSnapshot(this.heldByPackages);
    this.heldByPackages = new Map(derived.map(({ status, packaged }) => [status.mod, packaged]));
    const heldChanged = heldSnapshot(this.heldByPackages) !== heldBefore;
    this.hold(new Map(derived.map(({ status }) => [status.mod, status])), heldChanged);
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

  private async statusAgainstManifest(mod: ModAndSourceFolder, heldByGit: readonly string[], flagged: StatusSource['flaggedHashes']): Promise<{ status: ModStatus; packaged: ReadonlySet<string> }> {
    const manifest = await manifestAt(mod.folder);
    const named = mod.sourceFolder === undefined ? manifest : await manifestAt(mod.sourceFolder);
    const values = await this.reads.modValue(mod.folder, askedBoth(packagesAskedAt(manifest), packagesAskedAt(named)), heldByGit);
    const status = judged(mod, manifest, values, flagged);
    if (status.unreadable !== undefined) return { status, packaged: new Set() };
    const unpackaged = status.noManifest ? mod.files.filter((path) => !isGitsOwn(path)) : status.unpackaged;
    return {
      status: { ...status, unpackaged: [...new Set([...unpackaged, ...heldByGit])].sort() },
      packaged: named.read !== undefined && 'manifest' in named.read ? filesAPackageHolds(named.read.manifest, values) : new Set(),
    };
  }

  // The installation file is the mod manager's record, so a folder git holds whole is warned of it too.
  private async statusOf(mod: ModAndSourceFolder, heldWhole: boolean, heldByGit: readonly string[], flagged: StatusSource['flaggedHashes']): Promise<{ status: ModStatus; packaged: ReadonlySet<string> }> {
    const [{ status, packaged }, installed, buildFile] = await Promise.all([
      heldWhole ? { status: heldWholeStatus(mod.name, heldByGit), packaged: new Set<string>() } : this.statusAgainstManifest(mod, heldByGit, flagged), this.reads.installationFile(mod.name, mod.folder),
      mod.sourceFolder === undefined ? undefined : buildFileAgainst(mod.sourceFolder),
    ]);
    return { status: { ...status, ...installed.kind === 'unreadable' ? { installationFileProblem: installed.reason } : {}, ...buildFile && { buildFile } }, packaged };
  }

  private hold(derived: ReadonlyMap<string, ModStatus>, heldChanged: boolean): void {
    const before = JSON.stringify([...this.derived]);
    this.derived = derived;
    if (JSON.stringify([...derived]) === before) {
      if (heldChanged) for (const listener of this.changed) listener();
      return;
    }
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
    for (const listener of [...this.changed, ...this.messageChanged]) listener();
  }
}

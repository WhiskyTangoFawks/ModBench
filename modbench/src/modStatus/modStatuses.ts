// target-architecture.d2's Mod status; the mod-status trace.

import type { EntryRef, InstanceAdapter, ModFolder } from '../instanceAdapter/instanceAdapter';
import { buildFileAgainst, heldWholeStatus, manifestAt, packagesAskedAt, statusFrom, unreadableStatus, type ModAt, type ModStatus } from '../manifestAdapter/manifestAdapter';

/** What a status is derived from in an instance value. */
export interface StatusSource {
  readonly holdsRepository: boolean;
  readonly mods: readonly EntryRef[];
  readonly modFolders: readonly ModFolder[] | undefined;
  readonly entryKey: (entry: EntryRef) => string;
  /** Each source mod's source folder, by its entry's name. */
  readonly paths: { readonly sourceDirs: ReadonlyMap<string, string> };
  /** Each listed mod's own files, by its entry's name: what the reading already holds. */
  readonly filesByMod: ReadonlyMap<string, readonly { readonly relativePath: string }[]>;
}

const isGitsOwn = (path: string): boolean => path === '.git' || path.startsWith('.git/');

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

const listenedBy = (listeners: Set<() => void>, listener: () => void): Listening => {
  listeners.add(listener);
  return { dispose: () => { listeners.delete(listener); } };
};

/** Each mod's status, derived from the latest instance value while the instance holds a repository. An unreadable
 *  status keeps the last good one shown, and says why on the message line and once in the Output (common.md, Reporting). */
export class ModStatuses {
  private derived: ReadonlyMap<string, ModStatus> = new Map();
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
    const statuses = await Promise.all(mods.map((mod) => this.statusOf(mod, held.whole.has(mod.folder), held.files.get(mod.folder) ?? [])));
    this.hold(new Map(statuses.map((status) => [status.mod, status])));
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

  private async statusAgainstManifest(mod: ModAndSourceFolder, heldByGit: readonly string[]): Promise<ModStatus> {
    const manifest = await manifestAt(mod.folder);
    const status = statusFrom(mod, manifest, await this.reads.modValue(mod.folder, packagesAskedAt(manifest), heldByGit));
    if (status.unreadable !== undefined) return status;
    const unpackaged = status.noManifest ? mod.files.filter((path) => !isGitsOwn(path)) : status.unpackaged;
    return { ...status, unpackaged: [...new Set([...unpackaged, ...heldByGit])].sort() };
  }

  // The installation file is the mod manager's record, so a folder git holds whole is warned of it too.
  private async statusOf(mod: ModAndSourceFolder, heldWhole: boolean, heldByGit: readonly string[]): Promise<ModStatus> {
    const [status, installed, buildFile] = await Promise.all([
      heldWhole ? heldWholeStatus(mod.name, heldByGit) : this.statusAgainstManifest(mod, heldByGit), this.reads.installationFile(mod.name, mod.folder),
      mod.sourceFolder === undefined ? undefined : buildFileAgainst(mod.sourceFolder),
    ]);
    return { ...status, ...installed.kind === 'unreadable' ? { installationFileProblem: installed.reason } : {}, ...buildFile && { buildFile } };
  }

  private hold(derived: ReadonlyMap<string, ModStatus>): void {
    const before = JSON.stringify([...this.derived]);
    this.derived = derived;
    if (JSON.stringify([...derived]) === before) return;
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

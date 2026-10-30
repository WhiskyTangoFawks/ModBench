// target-architecture.d2's Mod status; the mod-status trace.

import type { EntryRef, ModFolder } from '../instanceAdapter/instanceAdapter';
import { statusOf, type FolderReads, type ModAt, type ModStatus } from '../manifestAdapter/manifestAdapter';

/** What a status is derived from in an instance value. */
export interface StatusSource {
  readonly holdsRepository: boolean;
  readonly mods: readonly EntryRef[];
  readonly modFolders: readonly ModFolder[] | undefined;
  readonly entryKey: (entry: EntryRef) => string;
  readonly paths: { readonly sourceDirs: ReadonlyMap<string, string> };
}

interface Listening {
  dispose(): void;
}

// A source mod's manifest is in its repository (ADR-0022).
function modsAt(value: StatusSource): ModAt[] {
  const keyOf = (entry: EntryRef): string => `${entry.kind}:${value.entryKey(entry)}`;
  const folders = new Map((value.modFolders ?? []).map((folder) => [keyOf(folder), folder]));
  return value.mods.flatMap((entry) => {
    const folder = folders.get(keyOf(entry));
    const sourceFolder = entry.kind === 'mod' ? value.paths.sourceDirs.get(entry.name) : undefined;
    return folder === undefined ? [] : [{ name: folder.modName, folder: folder.path, ...(sourceFolder === undefined ? {} : { sourceFolder }) }];
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
  private waiting: StatusSource | undefined;
  private deriving = false;
  private derivation: Promise<void> = Promise.resolve();
  private readonly changed = new Set<() => void>();
  private readonly messageChanged = new Set<() => void>();

  constructor(private readonly reads: FolderReads, private readonly log: (line: string) => void) {}

  /** Derives every status again from `value`; of the values handed while one derives, the latest alone derives next. */
  derive(value: StatusSource): void {
    this.waiting = value;
    if (this.deriving) return;
    this.deriving = true;
    this.derivation = this.deriveWhileWaiting();
  }

  /** The statuses derived from the latest value handed, each as read, an unreadable one too. */
  async current(): Promise<ReadonlyMap<string, ModStatus>> {
    await this.derivation;
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
    try {
      for (let value = this.waiting; value !== undefined; value = this.waiting) {
        this.waiting = undefined;
        const statuses = value.holdsRepository ? await Promise.all(modsAt(value).map((mod) => statusOf(mod, this.reads))) : [];
        this.hold(new Map(statuses.map((status) => [status.mod, status])));
      }
    } finally {
      this.deriving = false;
    }
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
      if (this.unreadable.get(status.mod) !== status.unreadable) this.log(`The status of "${status.mod}" could not be read: ${status.unreadable}`);
      this.unreadable.set(status.mod, status.unreadable);
    }
    for (const listener of [...this.changed, ...this.messageChanged]) listener();
  }
}

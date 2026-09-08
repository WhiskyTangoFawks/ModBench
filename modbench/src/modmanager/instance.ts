// The Instance: one read model over the MO2 instance directory's files (ADR-0047). It owns the
// MO2-side watchers, holds one whole value, and is built only by watching.

import type * as vscode from 'vscode';
import type { IModlistSource, ModlistEntry } from './model';
import { buildFileConflictIndex, FileConflictLookup, type FileConflictIndex } from './fileConflictIndex';
import { buildLoadOrderSnapshot, type LoadOrderPlugin } from './loadOrderSnapshot';
import { createModsWatcher } from './modsWatcher';
import { createModlistWatcher } from './modlistWatcher';
import { createOverwriteWatcher } from './overwriteWatcher';
import { createPluginsTxtWatcher } from './pluginsTxtWatcher';

// One wait for the whole model: an extraction or a purge bursts across several watchers at
// once, and a whole walk of a 764-mod instance measures ~0.1s.
const DEBOUNCE_MS = 200;

/** The winner lookup minus its one mutator: a value is replaced whole, never patched. */
export type FileWinners = Omit<FileConflictIndex['files'], 'set'>;

/** One generation of the MO2 side, whole. Every field comes from the same read of disk, so a
 *  consumer holding one can never hold two facts from two generations. */
export interface InstanceValue {
  /** Mods and separators in Mod override order, winning-first, with `enabled`. */
  readonly mods: readonly ModlistEntry[];
  /** The winning enabled provider of every relative path, and its contenders. */
  readonly files: FileWinners;
  /** Each enabled mod's own files. */
  readonly filesByMod: ReadonlyMap<string, readonly { relativePath: string; absolutePath: string }[]>;
  /** Every physical plugin copy, with origin, slot, enabled and winning (ADR-0044). */
  readonly plugins: readonly LoadOrderPlugin[];
}

export type InstanceSubscriber = (value: InstanceValue, sequence: number) => void;

type InstanceSource = Pick<IModlistSource, 'readModlist' | 'readPluginOrder' | 'readEnabledPlugins'>;

export interface InstanceOptions {
  instanceRoot: string;
  source: InstanceSource;
  dataFolder: () => Promise<string>;
  log: (msg: string) => void;
}

const EMPTY: InstanceValue = { mods: [], files: new FileConflictLookup(), filesByMod: new Map(), plugins: [] };

export class Instance implements vscode.Disposable {
  private current: InstanceValue = EMPTY;

  private seq = 0;

  private subscribers: InstanceSubscriber[] = [];

  private timer: ReturnType<typeof setTimeout> | undefined;

  // Recomputes never overlap, so a slow walk cannot publish over a newer one.
  private queue: Promise<void> = Promise.resolve();

  private readonly watchers: vscode.Disposable[];

  constructor(private readonly options: InstanceOptions) {
    const schedule = () => this.schedule();
    // Each watcher's own coalescing is off: a burst spanning several of them is one recompute,
    // so the single wait belongs to the model rather than stacking one per signal.
    this.watchers = [
      createModsWatcher(options.instanceRoot, schedule, 0),
      createModlistWatcher(options.instanceRoot, schedule, 0),
      createPluginsTxtWatcher(options.instanceRoot, schedule, 0),
      createOverwriteWatcher(options.instanceRoot, schedule, 0),
    ];
  }

  /** Never undefined and never partial: before the first read it is the empty value at
   *  sequence 0. */
  get value(): InstanceValue {
    return this.current;
  }

  /** Rises once per landed recompute. A failed read leaves it where it was. */
  get sequence(): number {
    return this.seq;
  }

  /** Called with each landed value and the sequence it landed at. */
  subscribe(subscriber: InstanceSubscriber): vscode.Disposable {
    this.subscribers.push(subscriber);
    return {
      dispose: () => {
        this.subscribers = this.subscribers.filter((s) => s !== subscriber);
      },
    };
  }

  /** The recompute activation runs, and the one that corrects the value after a watcher event
   *  the platform never delivered. Identical to the one an event runs. */
  refresh(): Promise<void> {
    return this.run();
  }

  dispose(): void {
    clearTimeout(this.timer);
    for (const watcher of this.watchers) watcher.dispose();
    this.subscribers = [];
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.run(), DEBOUNCE_MS);
  }

  private run(): Promise<void> {
    const task = this.queue.then(() => this.recompute());
    this.queue = task;
    return task;
  }

  // A half-written file from MO2 is a read that throws, so a failure logs and leaves the last
  // value in place rather than emptying the trees.
  private async recompute(): Promise<void> {
    let next: InstanceValue;
    try {
      next = await this.read();
    } catch (err) {
      this.options.log(
        `[instance] recompute failed, keeping the value at sequence ${this.seq}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    this.current = next;
    this.seq++;
    for (const subscriber of [...this.subscribers]) subscriber(next, this.seq);
  }

  private async read(): Promise<InstanceValue> {
    const { instanceRoot, source, dataFolder, log } = this.options;
    const entries = await source.readModlist();
    const index = await buildFileConflictIndex(entries, instanceRoot, log);
    const plugins = await buildLoadOrderSnapshot(
      // The modlist is read once per recompute and handed on, so the snapshot cannot see a
      // different generation of it than the file index did.
      {
        readModlist: () => Promise.resolve(entries),
        readPluginOrder: () => source.readPluginOrder(),
        readEnabledPlugins: () => source.readEnabledPlugins(),
      },
      instanceRoot,
      await dataFolder(),
      () => Promise.resolve(index),
    );
    return { mods: entries, files: index.files, filesByMod: index.filesByMod, plugins };
  }
}

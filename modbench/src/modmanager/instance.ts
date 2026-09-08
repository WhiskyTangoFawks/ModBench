// The Instance: one read model over the MO2 instance directory's files (ADR-0047). It owns the
// MO2-side watchers, holds one whole value, and is built only by watching.

import type * as vscode from 'vscode';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { IModlistSource, ModlistEntry } from './model';
import { buildFileConflictIndex, FileConflictLookup, type FileConflictIndex } from './fileConflictIndex';
import { buildLoadOrderRows, type LoadOrderPlugin, type LoadOrderPluginLine } from './loadOrderSnapshot';
import { createModsWatcher } from './modsWatcher';
import { createModlistWatcher } from './modlistWatcher';
import { createOverwriteWatcher } from './overwriteWatcher';
import { createPluginsTxtWatcher } from './pluginsTxtWatcher';
import { createDownloadsWatcher } from './downloadsWatcher';
import { scanDownloads } from './DownloadsPanel';
import { buildDownloadRows, type DownloadRow } from './mo2/downloads';
import { readGameName, readSelectedProfile } from './mo2/modOrganizerIni';
import { resolveGameDirectory, type ConfigLike, type DetectPaths, type DetectWinePrefix, type GameDirectory } from './gameDirectory';
import type { OnConfigChange } from './gameDirectoryResolver';
import { isDeployed } from './deployer';
import { computeModStatuses, type ModStatusResult } from './statusChecker';
import { readVanillaMasters } from './vanillaMasters';
import { countOverwriteFiles } from './overwriteFolder';

// A change here must recompute exactly as a file event does — the Instance's own replacement
// for the memoized resolver's invalidation.
const GAME_DIRECTORY_SECTION = 'modbench.mods.gameDirectory';

// How long an MO2 write takes to settle: the wait that coalesces a burst into one recompute, and
// the wait before an empty modlist read is believed.
const SETTLE_MS = 200;

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
  /** Every physical plugin copy, with origin, slot, enabled and winning (ADR-0044). A listed
   *  name neither a mod nor overwrite/ provides is still a row — a line-only one, `path`
   *  undefined — when the game directory is unresolved. */
  readonly plugins: readonly (LoadOrderPlugin | LoadOrderPluginLine)[];
  /** downloads/ rows, `.meta` sidecars folded in — status and hidden included. */
  readonly downloads: readonly DownloadRow[];
  /** ModOrganizer.ini's `selected_profile`. */
  readonly activeProfile: string;
  /** ModOrganizer.ini's `gameName`. */
  readonly gameRelease: string;
  /** Setting, then MO2's `gamePath`, then autodetect; undefined when none resolve. */
  readonly gameDirectory: GameDirectory | undefined;
  /** Whether mods/.medit-manifest.json is present — Modbench's own standalone deploy. */
  readonly deployed: boolean;
  /** Each mod's conflict/override/missing-master/missing-mod status, keyed by mod name — the
   *  Mods tree's badges (ADR-0047). */
  readonly modStatuses: ReadonlyMap<string, ModStatusResult>;
  /** File count under overwrite/, recursive; 0 when the folder is absent or empty. */
  readonly overwriteFileCount: number;
}

export type InstanceSubscriber = (value: InstanceValue, sequence: number) => void;

type InstanceSource = Pick<IModlistSource, 'readModlist' | 'readPluginOrder' | 'readEnabledPlugins'>;

export interface InstanceOptions {
  instanceRoot: string;
  source: InstanceSource;
  config: () => ConfigLike;
  detectPaths: DetectPaths;
  detectWinePrefix: DetectWinePrefix;
  onConfigChange: OnConfigChange;
  log: (msg: string) => void;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const EMPTY: InstanceValue = {
  mods: [],
  files: new FileConflictLookup(),
  filesByMod: new Map(),
  plugins: [],
  downloads: [],
  activeProfile: '',
  gameRelease: '',
  gameDirectory: undefined,
  deployed: false,
  modStatuses: new Map(),
  overwriteFileCount: 0,
};

export class Instance implements vscode.Disposable {
  private current: InstanceValue = EMPTY;

  private seq = 0;

  private subscribers: InstanceSubscriber[] = [];

  private timer: ReturnType<typeof setTimeout> | undefined;

  // Recomputes never overlap, so a slow walk cannot publish over a newer one.
  private queue: Promise<void> = Promise.resolve();

  private readonly watchers: vscode.Disposable[];

  private readonly configSubscription: { dispose(): void };

  constructor(private readonly options: InstanceOptions) {
    const schedule = () => this.schedule();
    // Each watcher's own coalescing is off: a burst spanning several of them is one recompute,
    // so the single wait belongs to the Instance rather than stacking one per signal.
    this.watchers = [
      createModsWatcher(options.instanceRoot, schedule, 0),
      createModlistWatcher(options.instanceRoot, schedule, 0),
      createPluginsTxtWatcher(options.instanceRoot, schedule, 0),
      createOverwriteWatcher(options.instanceRoot, schedule, 0),
      createDownloadsWatcher(options.instanceRoot, schedule, 0),
    ];
    // The game directory setting is editable while Modbench runs, so a change to it is a
    // recompute trigger like any watched file, not just a cache invalidation.
    this.configSubscription = options.onConfigChange((e) => {
      if (e.affectsConfiguration(GAME_DIRECTORY_SECTION)) schedule();
    });
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
    clearTimeout(this.timer); // a refresh mid-burst is the burst's recompute, not a second one
    return this.run();
  }

  dispose(): void {
    clearTimeout(this.timer);
    for (const watcher of this.watchers) watcher.dispose();
    this.configSubscription.dispose();
    this.subscribers = [];
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.run(), SETTLE_MS);
  }

  private run(): Promise<void> {
    const task = this.queue.then(() => this.recompute());
    this.queue = task;
    return task;
  }

  // A read that throws logs and leaves the last value and the last sequence in place, so a file
  // MO2 is half-way through writing never empties the trees.
  private async recompute(): Promise<void> {
    let next: InstanceValue;
    try {
      next = await this.read();
    } catch (err) {
      this.options.log(`[instance] recompute failed, keeping the value at sequence ${this.seq}: ${message(err)}`);
      return;
    }
    this.current = next;
    this.seq++;
    for (const subscriber of [...this.subscribers]) {
      try {
        subscriber(next, this.seq);
      } catch (err) {
        // A throwing subscriber would otherwise reject the queue for good, and no later
        // recompute would run — the dead chain tail Mo2ModlistSource's mutex documents.
        this.options.log(`[instance] subscriber threw at sequence ${this.seq}: ${message(err)}`);
      }
    }
  }

  // A truncated modlist.txt parses to no entries, and zero mods is legal, so an empty parse is
  // re-read after a settle before being believed. A partial parse is not covered — it reads as
  // a real removal.
  private async readMods(): Promise<ModlistEntry[]> {
    const entries = await this.options.source.readModlist();
    if (entries.length > 0) return entries;
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    const confirmed = await this.options.source.readModlist();
    if (confirmed.length > 0) {
      this.options.log(`[instance] modlist read as empty mid-write; the re-read found ${confirmed.length} entries`);
    }
    return confirmed;
  }

  private async read(): Promise<InstanceValue> {
    const { instanceRoot, source, config, detectPaths, detectWinePrefix, log } = this.options;
    const entries = await this.readMods();
    const [index, iniText, downloadEntries, deployed, overwriteFileCount] = await Promise.all([
      buildFileConflictIndex(entries, instanceRoot, log),
      readFile(join(instanceRoot, 'ModOrganizer.ini'), 'utf8'),
      scanDownloads(instanceRoot),
      isDeployed(instanceRoot),
      countOverwriteFiles(join(instanceRoot, 'overwrite')),
    ]);
    // The ini is read once above and handed to resolveGameDirectory as-is, so a rewrite
    // between it and activeProfile/gameRelease below cannot land two generations in one value.
    const gameDirectory = await resolveGameDirectory(
      instanceRoot, config(), detectPaths, detectWinePrefix, () => Promise.resolve(iniText));
    // Both derive from the same index and gameDirectory generation, so they run concurrently.
    const [plugins, modStatuses] = await Promise.all([
      // An unresolved game directory loses only the Data-folder copies' paths: every
      // plugins.txt line still gets a row, existence/slot/enabled coming from the line
      // itself (see `LoadOrderPluginLine`), not from the game directory.
      buildLoadOrderRows(
        // The modlist is read once per recompute and handed on, so the snapshot cannot see a
        // different generation of it than the file index did.
        {
          readModlist: () => Promise.resolve(entries),
          readPluginOrder: () => source.readPluginOrder(),
          readEnabledPlugins: () => source.readEnabledPlugins(),
        },
        instanceRoot,
        gameDirectory?.dataFolder,
        () => Promise.resolve(index),
      ),
      // An unresolved game directory degrades to an empty vanilla-master set rather than
      // failing the badge — same fallback readVanillaMasters/computeModStatuses already had
      // as the Mods tree's own read, moved here unchanged (ADR-0047).
      readVanillaMasters(gameDirectory?.dataFolder, log).then(
        (vanillaMasters) => computeModStatuses(entries, instanceRoot, index, vanillaMasters, log)),
    ]);
    return {
      mods: entries,
      files: index.files,
      filesByMod: index.filesByMod,
      plugins,
      downloads: downloadEntries ? buildDownloadRows(downloadEntries) : [],
      activeProfile: readSelectedProfile(iniText),
      gameRelease: readGameName(iniText),
      gameDirectory: gameDirectory ?? undefined,
      deployed,
      modStatuses,
      overwriteFileCount,
    };
  }
}

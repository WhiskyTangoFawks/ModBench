// The Instance: one read model over the MO2 instance directory's files (ADR-0047). It owns the
// MO2-side watchers, holds one whole value, and is built only by watching.

import type * as vscode from 'vscode';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Reporter } from '../reporter';
import type { ModlistEntry, PluginEntry } from './model';
import { buildFileConflictIndex, FileConflictLookup, type FileWinners } from './fileConflictIndex';
import { buildLoadOrderRows, type LoadOrderPlugin, type LoadOrderPluginLine } from './loadOrderSnapshot';
import { createDebouncedFsWatcher } from './fsWatcher';
import { createModsWatcher } from './modsWatcher';
import { createModlistWatcher } from './modlistWatcher';
import { createOverwriteWatcher } from './overwriteWatcher';
import { createPluginsTxtWatcher } from './pluginsTxtWatcher';
import { createDownloadsWatcher } from './downloadsWatcher';
import { scanDownloads } from './DownloadsPanel';
import { buildDownloadRows, type DownloadRow } from './mo2/downloads';
import { readGameName, readSelectedProfile } from './mo2/modOrganizerIni';
import { parseModlist } from './mo2/modlistText';
import { parsePlugins } from './mo2/pluginsText';
import { parseMetaIni } from './mo2/metaIni';
import { resolveGameDirectory, type ConfigLike, type DetectPaths, type DetectWinePrefix, type GameDirectory } from './gameDirectory';
import type { OnConfigChange } from './gameDirectoryResolver';
import { isDeployed } from './deployer';
import { computeModStatuses, type ModStatusResult } from './statusChecker';
import { countOverwriteFiles } from './overwriteFolder';

// A change here must recompute exactly as a file event does — the Instance's own replacement
// for the memoized resolver's invalidation.
const GAME_DIRECTORY_SECTION = 'modbench.mods.gameDirectory';

// How long an MO2 write takes to settle: the wait that coalesces a burst into one recompute, and
// the wait before an empty modlist read is believed.
const SETTLE_MS = 200;

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
  /** Each mod's conflict/override/missing-mod status, keyed by mod name — the Mods tree's
   *  badges (ADR-0047). */
  readonly modStatuses: ReadonlyMap<string, ModStatusResult>;
  /** File count under overwrite/, recursive; 0 when the folder is absent or empty. */
  readonly overwriteFileCount: number;
}

export type InstanceSubscriber = (value: InstanceValue, sequence: number) => void;

/** Hears each recompute that failed, with the read's own reason. The value and sequence are
 *  where they were: before the first landed value that is the empty sentinel at 0. */
export type ReadFailureListener = (reason: string) => void;

/** The Instance as a tree reads it: the held value, sequence and read failure, plus the two
 *  channels they move on. */
export type InstanceView = Pick<Instance, 'value' | 'sequence' | 'readFailure' | 'subscribe' | 'onReadFailure'>;

export interface InstanceOptions {
  instanceRoot: string;
  config: () => ConfigLike;
  detectPaths: DetectPaths;
  detectWinePrefix: DetectWinePrefix;
  onConfigChange: OnConfigChange;
  log: (msg: string) => void;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const profileFile = (instanceRoot: string, profile: string, name: string): string =>
  join(instanceRoot, 'profiles', profile, name);

// A mod with no meta.ini has no metadata; a present-but-unreadable one is a real failure.
async function readMeta(instanceRoot: string, modName: string): Promise<Partial<ModlistEntry>> {
  try {
    return parseMetaIni(await readFile(join(instanceRoot, 'mods', modName, 'meta.ini'), 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
}

async function readModlistEntries(instanceRoot: string, profile: string): Promise<ModlistEntry[]> {
  const entries = parseModlist(await readFile(profileFile(instanceRoot, profile, 'modlist.txt'), 'utf8'));
  return Promise.all(entries.map(async (entry) =>
    (entry.kind === 'mod' ? { ...entry, ...(await readMeta(instanceRoot, entry.name)) } : entry)));
}

async function readPluginEntries(instanceRoot: string, profile: string): Promise<PluginEntry[]> {
  return parsePlugins(await readFile(profileFile(instanceRoot, profile, 'plugins.txt'), 'utf8'));
}

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

  private failure: string | undefined;

  private subscribers: InstanceSubscriber[] = [];

  private failureListeners: ReadFailureListener[] = [];

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
      // A profile switch rewrites this file and nothing else, so without it the value keeps
      // naming the profile the user left — and a write verb would edit that profile's files.
      createDebouncedFsWatcher(options.instanceRoot, 'ModOrganizer.ini', schedule, 0),
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

  /** The latest recompute's failure reason, undefined once a recompute lands. Held, not just
   *  fired, so a tree subscribing after the failure still hears it. */
  get readFailure(): string | undefined {
    return this.failure;
  }

  /** Called with each landed value and the sequence it landed at, never with a failure. */
  subscribe(subscriber: InstanceSubscriber): vscode.Disposable {
    this.subscribers.push(subscriber);
    return {
      dispose: () => {
        this.subscribers = this.subscribers.filter((s) => s !== subscriber);
      },
    };
  }

  /** Called with each failed recompute's reason. A separate channel from `subscribe`, so a
   *  landed-value subscriber (the load-order PUT above all) never runs on a failure. */
  onReadFailure(listener: ReadFailureListener): vscode.Disposable {
    this.failureListeners.push(listener);
    return {
      dispose: () => {
        this.failureListeners = this.failureListeners.filter((l) => l !== listener);
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
    this.failureListeners = [];
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
      this.failure = message(err);
      this.notify(this.failureListeners, (listener) => listener(this.failure!));
      return;
    }
    this.current = next;
    this.failure = undefined;
    this.seq++;
    this.notify(this.subscribers, (subscriber) => subscriber(next, this.seq));
  }

  // A throwing subscriber would otherwise reject the queue for good, and no later recompute
  // would run — the dead chain tail every write queue's tail-catch documents.
  private notify<T>(listeners: readonly T[], call: (listener: T) => void): void {
    for (const listener of [...listeners]) {
      try {
        call(listener);
      } catch (err) {
        this.options.log(`[instance] subscriber threw at sequence ${this.seq}: ${message(err)}`);
      }
    }
  }

  // A truncated modlist.txt parses to no entries, and zero mods is legal, so an empty parse is
  // re-read after a settle before being believed. A partial parse is not covered — it reads as
  // a real removal.
  private async readMods(profile: string): Promise<ModlistEntry[]> {
    const entries = await readModlistEntries(this.options.instanceRoot, profile);
    if (entries.length > 0) return entries;
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    const confirmed = await readModlistEntries(this.options.instanceRoot, profile);
    if (confirmed.length > 0) {
      this.options.log(`[instance] modlist read as empty mid-write; the re-read found ${confirmed.length} entries`);
    }
    return confirmed;
  }

  private async read(): Promise<InstanceValue> {
    const { instanceRoot, config, detectPaths, detectWinePrefix, log } = this.options;
    // The ini is read first and every later read is against the profile it names, so a profile
    // switch mid-recompute cannot mix one profile's modlist with another's plugins.txt.
    const iniText = await readFile(join(instanceRoot, 'ModOrganizer.ini'), 'utf8');
    const profile = readSelectedProfile(iniText);
    const entries = await this.readMods(profile);
    // One read of plugins.txt per recompute, shared by the order and the enabled subset below.
    const [index, pluginLines, downloadEntries, deployed, overwriteFileCount] = await Promise.all([
      buildFileConflictIndex(entries, instanceRoot, log),
      readPluginEntries(instanceRoot, profile),
      scanDownloads(instanceRoot),
      isDeployed(instanceRoot),
      countOverwriteFiles(join(instanceRoot, 'overwrite')),
    ]);
    // The ini is read once above and handed to resolveGameDirectory as-is, so a rewrite
    // between it and activeProfile/gameRelease below cannot land two generations in one value.
    const gameDirectory = await resolveGameDirectory(
      instanceRoot, config(), detectPaths, detectWinePrefix, () => Promise.resolve(iniText));
    // Both derive from the same index generation, so they run concurrently.
    const [plugins, modStatuses] = await Promise.all([
      // An unresolved game directory loses only the Data-folder copies' paths: every
      // plugins.txt line still gets a row, existence/slot/enabled coming from the line
      // itself (see `LoadOrderPluginLine`), not from the game directory.
      buildLoadOrderRows(
        // The modlist is read once per recompute and handed on, so the snapshot cannot see a
        // different generation of it than the file index did.
        {
          readModlist: () => Promise.resolve(entries),
          readPluginOrder: () => Promise.resolve(pluginLines.map((p) => p.name)),
          readEnabledPlugins: () => Promise.resolve(pluginLines.filter((p) => p.enabled).map((p) => p.name)),
        },
        instanceRoot,
        gameDirectory?.dataFolder,
        () => Promise.resolve(index),
      ),
      computeModStatuses(entries, instanceRoot, index),
    ]);
    return {
      mods: entries,
      files: index.files,
      filesByMod: index.filesByMod,
      plugins,
      downloads: downloadEntries ? buildDownloadRows(downloadEntries) : [],
      activeProfile: profile,
      gameRelease: readGameName(iniText),
      gameDirectory: gameDirectory ?? undefined,
      deployed,
      modStatuses,
      overwriteFileCount,
    };
  }
}

/** A tree's first-render gate: `settled` resolves on the first landed value or the first failed
 *  read — never "nothing here" before a read (ADR-0035), never an endless spinner (ADR-0026).
 *  `failure` holds until a value lands. */
export interface FirstRead extends vscode.Disposable {
  readonly settled: Promise<void>;
  readonly failure: string | undefined;
}

/** The reporter hears the first failed read once; a later failure before any value has landed
 *  is the Instance's log line, nothing more, so a retrying watcher cannot toast per attempt. */
export function firstReadOf(
  instance: Pick<Instance, 'sequence' | 'readFailure' | 'subscribe' | 'onReadFailure'>,
  reporter: Reporter | undefined,
): FirstRead {
  const unread = () => instance.sequence === 0;
  let reported = false;
  const report = (reason: string) => {
    if (reported) return;
    reported = true;
    reporter?.report('error', 'Failed to read the MO2 instance.', reason);
  };
  let resolve = () => {};
  const settled = unread() ? new Promise<void>((r) => { resolve = r; }) : Promise.resolve();
  // Constructed after the first read already failed: the failure is held, not just fired.
  if (unread() && instance.readFailure !== undefined) {
    report(instance.readFailure);
    resolve();
  }
  const subscriptions = [
    instance.subscribe(() => resolve()),
    instance.onReadFailure((reason) => {
      if (!unread()) return;
      report(reason);
      resolve();
    }),
  ];
  return {
    settled,
    get failure() { return unread() ? instance.readFailure : undefined; },
    dispose: () => { for (const subscription of subscriptions) subscription.dispose(); },
  };
}

/** ADR-0044's snapshot, read from the current value (ADR-0047) rather than a fresh walk.
 *  `undefined` — no PUT — when the game directory has not resolved. The filter states a
 *  resolved game directory's own guarantee, never an unchecked cast. */
export function loadOrderSnapshotOf(
  value: Pick<InstanceValue, 'plugins' | 'gameDirectory'>,
): { dataFolder: string; plugins: LoadOrderPlugin[] } | undefined {
  if (!value.gameDirectory) return undefined;
  return {
    dataFolder: value.gameDirectory.dataFolder,
    plugins: value.plugins.filter((p): p is LoadOrderPlugin => p.path !== undefined),
  };
}

/** ADR-0044: a landed recompute is the sole trigger for a PUT — never a gesture, command or
 *  view calling `request()` directly. */
export function wireLoadOrderSyncToInstance(
  instance: Pick<Instance, 'subscribe'>, sync: { request(): void },
): vscode.Disposable {
  return instance.subscribe(() => sync.request());
}

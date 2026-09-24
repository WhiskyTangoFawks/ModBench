// The Instance: one read model over the MO2 instance directory's files (ADR-0015). It owns the
// MO2-side watchers, holds one whole value, and is built only by watching.

import type * as vscode from 'vscode';
import { errnoCode } from '../ports/errno';
import type { ModlistEntry } from '../mo2Codecs/modlistText';
import type { PluginEntry } from '../mo2Codecs/pluginsText';
import { buildFileConflictIndex, FileConflictLookup, type FileWinners } from './fileConflictIndex';
import {
  buildLoadOrderRows, readDataFolderPlugins,
  type DataFolderPlugins, type LoadOrderPlugin, type LoadOrderPluginLine,
} from './loadOrderSnapshot';
import { createDebouncedFsWatcher } from './fsWatcher';
import { createModsWatcher } from './modsWatcher';
import { createModlistWatcher } from './modlistWatcher';
import { createOverwriteWatcher } from './overwriteWatcher';
import { createPluginsTxtWatcher } from './pluginsTxtWatcher';
import { createDownloadsWatcher } from './downloadsWatcher';
import { scanDownloads } from './downloadsScan';
import { buildDownloadRows, modsByInstallationFile, type DownloadRow } from '../mo2Codecs/downloads';
import { SETTINGS_FILE_NAME, readGameName, readSelectedProfile } from '../mo2Codecs/modOrganizerIni';
import { nexusSlugForGame } from '../tables/gamePaths';
import { parseModlist } from '../mo2Codecs/modlistText';
import { parsePlugins } from '../mo2Codecs/pluginsText';
import { parseMetaIni } from '../mo2Codecs/metaIni';
import {
  downloadFile, downloadSidecarFile, downloadsDir, modDir, modMetaFile, modlistFile, modsDir, overwriteDir,
  pluginsFile, profilesDir, settingsFile,
} from '../instanceAdapter/layout';
import type { GameDirectory, GameDirectoryResolver } from '../instanceAdapter/gameDirectory';
import { computeModStatuses, type ModStatusResult } from './statusChecker';
import { countOverwriteFiles } from './overwriteFolder';
import { get, listDir } from '../instanceAdapter/files';
import { errorMessage } from '../ports/errorMessage';

/** The rows this value is made of. A view names a row's shape through the read model that
 *  publishes it, never through the codec that parsed the file behind it. */
export type { InstalledFileId } from '../mo2Codecs/metaIni';
export type { Mod, ModlistEntry, Separator } from '../mo2Codecs/modlistText';
export { OVERWRITE_DIR_NAME } from '../mo2Codecs/modlistText';
export type { PluginEntry } from '../mo2Codecs/pluginsText';
export type { DownloadRow, DownloadStatus } from '../mo2Codecs/downloads';

// How long an MO2 write takes to settle: the wait a burst coalesces into one recompute on, and
// the wait before an empty modlist read is believed.
const SETTLE_MS = 200;

/** A downloads/ row with the two paths a view opens or reveals, so that no view joins one. */
export interface DownloadFile extends DownloadRow {
  readonly path: string;
  readonly sidecarPath: string;
}

/** The instance paths a view renders or opens: the Instance adapter owns every path function, and
 *  a view reads the answer here. Filled from the instance directory alone, so they stand at
 *  sequence 0. */
export interface InstancePaths {
  readonly overwriteDir: string;
  readonly downloadsDir: string;
  /** Each listed mod's own folder, by mod name. */
  readonly modDirs: ReadonlyMap<string, string>;
}

/** One generation of the MO2 side, whole. Every field comes from the same read of disk, so a
 *  consumer holding one can never hold two facts from two generations. */
export interface InstanceValue {
  /** Mods and separators in Mod override order, winning-first, with `enabled`. */
  readonly mods: readonly ModlistEntry[];
  /** Every directory under mods/, listed or not: what mod sync compares modlist.txt with, and
   *  the new-empty-mod refusal's own input. Undefined when there is no mods/ to list. */
  readonly modFolders: readonly string[] | undefined;
  /** Every directory under profiles/, the switch's choices; a stray file MO2 left there is not
   *  one. */
  readonly profiles: readonly string[];
  /** The winning enabled provider of every relative path, and its contenders. */
  readonly files: FileWinners;
  /** Each enabled mod's own files. */
  readonly filesByMod: ReadonlyMap<string, readonly { relativePath: string; absolutePath: string }[]>;
  /** Every physical plugin copy, with origin, slot, enabled and winning (ADR-0013). A listed
   *  name neither a mod nor overwrite/ provides is still a row — a line-only one, `path`
   *  undefined — when the game directory is unresolved. */
  readonly plugins: readonly (LoadOrderPlugin | LoadOrderPluginLine)[];
  /** downloads/ rows, `.meta` sidecars folded in — status and hidden included. */
  readonly downloads: readonly DownloadFile[];
  /** ModOrganizer.ini's `selected_profile`. */
  readonly activeProfile: string;
  /** ModOrganizer.ini's `gameName`. */
  readonly gameRelease: string;
  /** The Nexus domain for that release, so a view linking to a mod page names no game itself. */
  readonly nexusSlug: string;
  /** Setting, then MO2's `gamePath`, then autodetect; undefined when none resolve. */
  readonly gameDirectory: GameDirectory | undefined;
  /** What the game's Data folder holds at its root — presence, never provision — or the reason
   *  it could not be read. */
  readonly dataFolderPlugins: DataFolderPlugins;
  /** Each mod's conflict/override status, keyed by mod name — the Mods tree's badges (ADR-0015). */
  readonly modStatuses: ReadonlyMap<string, ModStatusResult>;
  /** File count under overwrite/, recursive; 0 when the folder is absent or empty. */
  readonly overwriteFileCount: number;
  /** The paths this generation's rows name. */
  readonly paths: InstancePaths;
}

export type InstanceSubscriber = (value: InstanceValue, sequence: number) => void;

/** Hears each recompute that failed; `readFailure` holds the reason. The value and sequence are
 *  where they were: before the first landed value that is the empty sentinel at 0. */
export type ReadFailureListener = () => void;

/** The Instance as a tree reads it: the held value, sequence and read failure, plus the two
 *  channels they move on. */
export type InstanceView = Pick<Instance, 'value' | 'sequence' | 'readFailure' | 'subscribe' | 'onReadFailure'>;

export interface InstanceOptions {
  instanceRoot: string;
  /** Where the game is, answered by the Instance adapter for the ini text this recompute read.
   *  The only input besides the instance directory itself. */
  resolveGameDirectory: GameDirectoryResolver;
  log: (msg: string) => void;
  /** The failed read's one Output line, written at error level however many views show it. */
  logReadFailure: (line: string) => void;
}

// A mod with no meta.ini has no metadata; a present-but-unreadable one is a real failure.
async function readMeta(instanceRoot: string, modName: string): Promise<Partial<ModlistEntry>> {
  try {
    return parseMetaIni(await get(modMetaFile(instanceRoot, modName)));
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return {};
    throw err;
  }
}

// A missing mods/ is an answer, not a failed read: a workspace before its first install has
// none. Any other listing failure is a real one and fails the recompute.
async function readModFolderNames(instanceRoot: string): Promise<string[] | undefined> {
  try {
    const dirents = await listDir(modsDir(instanceRoot));
    return dirents.filter((d) => d.isDirectory()).map((d) => d.name);
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return undefined;
    throw err;
  }
}

// Installed reads every mod folder on disk, not one profile's modlist.txt lines: a folder no
// profile has synced into its modlist yet still owns its meta.ini's claim.
async function readInstalledInto(
  instanceRoot: string, modFolderNames: readonly string[],
): Promise<ReadonlyMap<string, readonly string[]>> {
  const metas = await Promise.all(modFolderNames.map(async (name) => {
    const meta = await readMeta(instanceRoot, name);
    return { name, archiveFilename: 'archiveFilename' in meta ? meta.archiveFilename : undefined };
  }));
  return modsByInstallationFile(metas);
}

async function readModlistEntries(instanceRoot: string, profile: string): Promise<ModlistEntry[]> {
  const entries = parseModlist(await get(modlistFile(instanceRoot, profile)));
  return Promise.all(entries.map(async (entry) =>
    (entry.kind === 'mod' ? { ...entry, ...(await readMeta(instanceRoot, entry.name)) } : entry)));
}

async function readPluginEntries(instanceRoot: string, profile: string): Promise<PluginEntry[]> {
  return parsePlugins(await get(pluginsFile(instanceRoot, profile)));
}

// An instance with no profiles/ offers no profile rather than failing the recompute, as a
// missing mods/ lists no mod.
async function readProfileNames(instanceRoot: string): Promise<string[]> {
  try {
    const dirents = await listDir(profilesDir(instanceRoot));
    return dirents.filter((d) => d.isDirectory()).map((d) => d.name);
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return [];
    throw err;
  }
}

const pathsOf = (instanceRoot: string, modNames: readonly string[]): InstancePaths => ({
  overwriteDir: overwriteDir(instanceRoot),
  downloadsDir: downloadsDir(instanceRoot),
  modDirs: new Map(modNames.map((name) => [name, modDir(instanceRoot, name)])),
});

const emptyValue = (instanceRoot: string): InstanceValue => ({
  mods: [],
  modFolders: [],
  profiles: [],
  files: new FileConflictLookup(),
  filesByMod: new Map(),
  plugins: [],
  downloads: [],
  activeProfile: '',
  gameRelease: '',
  nexusSlug: '',
  gameDirectory: undefined,
  dataFolderPlugins: { kind: 'unresolved' },
  modStatuses: new Map(),
  overwriteFileCount: 0,
  paths: pathsOf(instanceRoot, []),
});

export class Instance implements vscode.Disposable {
  private current: InstanceValue;

  private seq = 0;

  private failure: string | undefined;

  private subscribers: InstanceSubscriber[] = [];

  private failureListeners: ReadFailureListener[] = [];

  private timer: ReturnType<typeof setTimeout> | undefined;

  // Recomputes never overlap, so a slow walk cannot publish over a newer one.
  private queue: Promise<unknown> = Promise.resolve();

  private readonly watchers: vscode.Disposable[];

  constructor(private readonly options: InstanceOptions) {
    this.current = emptyValue(options.instanceRoot);
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
      createDebouncedFsWatcher(options.instanceRoot, SETTINGS_FILE_NAME, schedule, 0),
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

  /** Called on each failed recompute. A separate channel from `subscribe`, so a
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
   *  the platform never delivered. Identical to the one an event runs. Answers with this read's
   *  own failure, undefined when it landed. */
  refresh(): Promise<string | undefined> {
    clearTimeout(this.timer); // a refresh mid-burst is the burst's recompute, not a second one
    return this.run();
  }

  dispose(): void {
    clearTimeout(this.timer);
    for (const watcher of this.watchers) watcher.dispose();
    this.subscribers = [];
    this.failureListeners = [];
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.run(), SETTLE_MS);
  }

  private run(): Promise<string | undefined> {
    const task = this.queue.then(() => this.recompute());
    this.queue = task;
    return task;
  }

  // A read that throws logs and leaves the last value and the last sequence in place, so a file
  // MO2 is half-way through writing never empties the trees.
  private async recompute(): Promise<string | undefined> {
    let next: InstanceValue;
    try {
      next = await this.read();
    } catch (err) {
      const failure = errorMessage(err);
      this.options.logReadFailure(`[instance] Failed to read the MO2 instance: ${failure}`);
      this.failure = failure;
      this.notify(this.failureListeners, (listener) => listener());
      return failure;
    }
    this.current = next;
    this.failure = undefined;
    this.seq++;
    this.notify(this.subscribers, (subscriber) => subscriber(next, this.seq));
    return undefined;
  }

  // A throwing subscriber would otherwise reject the queue for good, and no later recompute
  // would run — the dead chain tail every write queue's tail-catch documents.
  private notify<T>(listeners: readonly T[], call: (listener: T) => void): void {
    for (const listener of [...listeners]) {
      try {
        call(listener);
      } catch (err) {
        this.options.log(`[instance] subscriber threw at sequence ${this.seq}: ${errorMessage(err)}`);
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
    const { instanceRoot, resolveGameDirectory, log } = this.options;
    // The ini is read first and every later read is against the profile it names, so a profile
    // switch mid-recompute cannot mix one profile's modlist with another's plugins.txt.
    const iniText = await get(settingsFile(instanceRoot));
    const profile = readSelectedProfile(iniText);
    const entries = await this.readMods(profile);
    // One read of plugins.txt per recompute, shared by the order and the enabled subset below.
    const [index, pluginLines, downloadEntries, overwriteFileCount, modFolderNames, profiles, game] = await Promise.all([
      buildFileConflictIndex(entries, instanceRoot, log),
      readPluginEntries(instanceRoot, profile),
      scanDownloads(instanceRoot),
      countOverwriteFiles(overwriteDir(instanceRoot)),
      readModFolderNames(instanceRoot),
      readProfileNames(instanceRoot),
      // The ini read above is handed to the resolver as-is, so a rewrite cannot land two
      // generations in one value; beside the reads above, the game side costs no round trip.
      resolveGameDirectory(iniText).then(async (gameDirectory) => ({
        gameDirectory, dataFolderPlugins: await readDataFolderPlugins(gameDirectory?.dataFolder, log),
      })),
    ]);
    const { gameDirectory, dataFolderPlugins } = game;
    // Every mod folder on disk, not this profile's modlist.txt lines: a folder synced into no
    // profile yet still owns its meta.ini's Installed claim.
    const installedInto = downloadEntries ? await readInstalledInto(instanceRoot, modFolderNames ?? []) : undefined;
    const gameName = readGameName(iniText);
    // An unresolved game directory loses only the Data-folder copies' paths: every
    // plugins.txt line still gets a row, existence/slot/enabled coming from the line
    // itself (see `LoadOrderPluginLine`), not from the game directory.
    const plugins = await buildLoadOrderRows(
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
    );
    const modStatuses = computeModStatuses(entries, index);
    return {
      mods: entries,
      modFolders: modFolderNames,
      profiles,
      files: index.files,
      filesByMod: index.filesByMod,
      plugins,
      downloads: downloadEntries && installedInto
        ? buildDownloadRows(downloadEntries, installedInto).map((row) => ({
          ...row,
          path: downloadFile(instanceRoot, row.name),
          sidecarPath: downloadSidecarFile(instanceRoot, row.name),
        }))
        : [],
      activeProfile: profile,
      gameRelease: gameName,
      nexusSlug: nexusSlugForGame(gameName),
      gameDirectory,
      dataFolderPlugins,
      modStatuses,
      overwriteFileCount,
      paths: pathsOf(instanceRoot, entries.filter((e) => e.kind === 'mod').map((e) => e.name)),
    };
  }
}

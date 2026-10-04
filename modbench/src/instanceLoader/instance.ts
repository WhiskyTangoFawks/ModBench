// The instance value (ADR-0015).

import { buildFileConflictIndex, FileConflictLookup, type FileWinners } from './fileConflictIndex';
import {
  buildLoadOrderRows, loadOrderSnapshotOf, pluginsLoadedWithNoLineOf, type DataFolderPlugins, type LoadOrderPlugin,
  type LoadOrderPluginLine, type LoadOrderSnapshotValue, type PluginAddress,
} from './loadOrderSnapshot';
import { buildDownloadRows, modsByInstallationFile, type DownloadFile } from './downloadRows';
import { gameMastersOf, nexusSlugFor } from '../tables/gamePaths';
import {
  GAME_FOLDER_SETTING, type DownloadedFiles, type GameFolder, type InstanceAdapter, type ModFolder, type ModFolders,
  type ManagerNames, type ModlistEntry, type OriginFile, type OriginFiles, type OriginFolder, type Subscription,
} from '../instanceAdapter/instanceAdapter';
import { SameCopies, type FileCopies } from './sameCopies';
import { errorMessage } from '../ports/errorMessage';
import { modSyncArgumentsOf, pluginSyncArgumentsOf, type ModSyncArguments, type PluginSyncArguments } from './syncArguments';

/** The rows this value is made of. A view names a row's shape through the read model that
 *  publishes it, never through the codec that parsed the file behind it. */
export type { FileOrigin, InstalledFileId, Mod, ModlistEntry, OriginFile, OriginFolder, PluginEntry, Separator } from '../instanceAdapter/instanceAdapter';
export type { DownloadFile, DownloadRow } from './downloadRows';
export type { Copy, FileCopies } from './sameCopies';
export type { ModSyncArguments, PluginSyncArguments } from './syncArguments';
export type { DownloadStatus } from '../instanceAdapter/instanceAdapter';
export type { GameFolder, GameFolderLook } from '../instanceAdapter/instanceAdapter';

// How long another tool's write takes to settle: the wait a burst coalesces into one recompute on,
// and the wait before an empty mod order is believed.
const SETTLE_MS = 200;

/** The rows the mod manager's downloads folder holds, or why Modbench could not resolve that
 *  folder at all — never rows from a folder the manager is not using (downloads.md, Which files
 *  are rows, story 1). */
export type DownloadsResult =
  | { readonly kind: 'listed'; readonly rows: readonly DownloadFile[] }
  | { readonly kind: 'unresolved'; readonly reason: string };

/** The instance paths a view renders or opens: the Instance adapter owns every path function, and
 *  a view reads its answer here. Each is read with the rest of the value, so the empty value
 *  names none. */
export interface InstancePaths {
  /** `undefined` until read, and when the instance gives run-time output no folder. */
  readonly overwriteDir: string | undefined;
  /** `undefined` while unresolved (or not yet read): a consumer skips the action, no fallback. */
  readonly downloadsDir: string | undefined;
  /** Each listed mod's own folder, by mod name; a mod with no folder has none. */
  readonly modDirs: ReadonlyMap<string, string>;
}

/** One generation of the instance, whole. Every field comes from the same read of disk, so a
 *  consumer holding one can never hold two facts from two generations. */
export interface InstanceValue {
  /** Mods and separators in Mod override order, winning-first, with `enabled`. */
  readonly mods: readonly ModlistEntry[];
  /** Every mod folder as the entry it holds, listed or not: what mod sync compares mod order
   *  with, and the new-empty-mod refusal's own input. Undefined when there is none to list. */
  readonly modFolders: readonly ModFolder[] | undefined;
  /** The tracked mods (ADR-0007). */
  readonly trackedMods: ReadonlySet<string>;
  /** Every profile, the switch's choices. */
  readonly profiles: readonly string[];
  /** The winning enabled provider of every relative path, and its contenders. */
  readonly files: FileWinners;
  /** Each listed mod's own files, a disabled mod's too. */
  readonly filesByMod: ReadonlyMap<string, readonly OriginFile[]>;
  /** Each listed mod's folders, a disabled mod's too. */
  readonly foldersByMod: ReadonlyMap<string, readonly OriginFolder[]>;
  /** Every plugin file, with origin, slot, enabled and winning. A listed
   *  name neither a mod nor overwrite/ provides is still a row — a line-only one, `path`
   *  undefined — when the game folder is not found. */
  readonly plugins: readonly (LoadOrderPlugin | LoadOrderPluginLine)[];
  /** The downloaded files' rows, their metadata folded in — status and excluded included; or the
   *  reason their folder could not be resolved. */
  readonly downloads: DownloadsResult;
  /** The profile the mod manager's configuration selects. */
  readonly activeProfile: string;
  /** How a message names the mod manager and its mod-order file: the adapter's answer, before any
   *  read too. */
  readonly managerNames: ManagerNames;
  /** The game as the mod manager's configuration names it. */
  readonly gameName: string;
  /** Mutagen's release of that game; undefined when the tables hold none for it. */
  readonly gameRelease: string | undefined;
  /** The Nexus domain for that release, so a view linking to a mod page names no game itself. */
  readonly nexusSlug: string;
  /** The setting, then the mod manager's configuration, then detection; or each place looked when
   *  none answered. */
  readonly gameFolder: GameFolder;
  /** What the game's Data folder holds at its root — presence, never provision — or the reason
   *  it could not be read. */
  readonly dataFolderPlugins: DataFolderPlugins;
  /** The plugins the game loads with no line, in the order it loads them; undefined while the
   *  game folder's plugins cannot be listed. */
  readonly pluginsLoadedWithNoLine: readonly PluginAddress[] | undefined;
  /** ADR-0013's snapshot; undefined while the game folder is not found or its plugins cannot be
   *  listed, so nothing silently wrong is sent. */
  readonly loadOrderSnapshot: LoadOrderSnapshotValue | undefined;
  /** Overwrite's own files, recursive; none when the folder is absent or empty. */
  readonly overwriteFiles: readonly OriginFile[];
  /** Overwrite's folders, as `overwriteFiles` holds its files. */
  readonly overwriteFolders: readonly OriginFolder[];
  /** The paths this generation's rows name. */
  readonly paths: InstancePaths;
  /** What mod sync is handed, derived once with the rest of the value. */
  readonly modSyncArguments: ModSyncArguments;
  /** What plugin sync is handed, derived once with the rest of the value. */
  readonly pluginSyncArguments: PluginSyncArguments;
}

export type InstanceSubscriber = (value: InstanceValue, sequence: number) => void;

/** Hears each recompute that failed; `readFailure` holds the reason. The value and sequence are
 *  where they were: before the first landed value that is the empty sentinel at 0. */
export type ReadFailureListener = () => void;

/** The Instance as a tree reads it: the held value, sequence and read failure, plus the two
 *  channels they move on. */
export type InstanceView = Pick<Instance, 'value' | 'sequence' | 'readFailure' | 'subscribe' | 'onReadFailure'>;

/** The message line a view shows once a read fails after rows landed: the rows stay (common.md,
 *  States, story 6). Before the first value it is the error row's business, not this. */
export function lastGoodReadMessage({ sequence, readFailure }: Pick<InstanceView, 'sequence' | 'readFailure'>): string | undefined {
  return sequence > 0 && readFailure !== undefined ? `Showing the last good read: ${readFailure}` : undefined;
}

/** As much of VS Code's window as the recompute reads. */
export interface FocusWindow {
  readonly state: { readonly focused: boolean };
  onDidChangeWindowState(listener: (state: { readonly focused: boolean }) => void): Subscription;
}

export interface InstanceOptions {
  /** The one reader of the instance; each recompute reads its settings once. */
  adapter: InstanceAdapter;
  window: FocusWindow;
  log: (msg: string) => void;
  /** The failed read's one Output line, written at error level however many views show it. */
  logReadFailure: (line: string) => void;
}

// Each listed mod's folder is matched as the manager matches names.
function pathsOf(
  runtimeOutput: OriginFiles, downloaded: DownloadedFiles, entries: readonly ModlistEntry[], modFolders: ModFolders | undefined,
): InstancePaths {
  return {
    overwriteDir: runtimeOutput.folder,
    downloadsDir: downloaded.kind === 'listed' ? downloaded.downloadsDir : undefined,
    modDirs: new Map(entries.flatMap((entry) => {
      const folder = entry.kind === 'mod' ? modFolders?.holding(entry) : undefined;
      return folder === undefined ? [] : [[entry.name, folder.path] as const];
    })),
  };
}

const emptyValue = (managerNames: ManagerNames): InstanceValue => ({
  mods: [],
  modFolders: [],
  trackedMods: new Set(),
  profiles: [],
  files: new FileConflictLookup(),
  filesByMod: new Map(),
  foldersByMod: new Map(),
  plugins: [],
  downloads: { kind: 'listed', rows: [] },
  activeProfile: '',
  managerNames,
  gameName: '',
  gameRelease: undefined,
  nexusSlug: '',
  // Not read yet reads as not found, so a view that says not found waits for sequence 1.
  gameFolder: { kind: 'notFound', looked: [], setting: GAME_FOLDER_SETTING },
  dataFolderPlugins: { kind: 'unresolved' },
  pluginsLoadedWithNoLine: undefined,
  loadOrderSnapshot: undefined,
  overwriteFiles: [],
  overwriteFolders: [],
  paths: { overwriteDir: undefined, downloadsDir: undefined, modDirs: new Map() },
  modSyncArguments: { profile: '', modFolders: [] },
  pluginSyncArguments: { profile: '', provided: new Map(), inData: { kind: 'unresolved' }, loadedWithNoLine: undefined },
});

export class Instance implements Subscription {
  private current: InstanceValue;

  private seq = 0;

  private failure: string | undefined;

  private subscribers: InstanceSubscriber[] = [];

  private failureListeners: ReadFailureListener[] = [];

  private timer: ReturnType<typeof setTimeout> | undefined;

  // Recomputes never overlap, so a slow walk cannot publish over a newer one.
  private queue: Promise<unknown> = Promise.resolve();

  private readonly changes: Subscription;

  private readonly focus: Subscription;

  // The mod folder links already told as skipped, so each is one Output line until it changes.
  private linksTold: ReadonlySet<string> = new Set();

  private readonly copies: SameCopies;

  constructor(private readonly options: InstanceOptions) {
    this.current = emptyValue(options.adapter.names);
    this.copies = new SameCopies(options.adapter);
    this.changes = options.adapter.subscribe(() => this.schedule());
    let focused = options.window.state.focused;
    this.focus = options.window.onDidChangeWindowState((state) => {
      if (state.focused && !focused) this.schedule();
      focused = state.focused;
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
  subscribe(subscriber: InstanceSubscriber): Subscription {
    this.subscribers.push(subscriber);
    return {
      dispose: () => {
        this.subscribers = this.subscribers.filter((s) => s !== subscriber);
      },
    };
  }

  /** Called on each failed recompute. A separate channel from `subscribe`, so a
   *  landed-value subscriber (the load-order PUT above all) never runs on a failure. */
  onReadFailure(listener: ReadFailureListener): Subscription {
    this.failureListeners.push(listener);
    return {
      dispose: () => {
        this.failureListeners = this.failureListeners.filter((l) => l !== listener);
      },
    };
  }

  /** The recompute activation runs, and the one that corrects the value after a change the
   *  adapter never signalled. Identical to the one a signal runs. Settles when its read has landed
   *  or failed. */
  refresh(): Promise<void> {
    clearTimeout(this.timer); // a refresh mid-burst is the burst's recompute, not a second one
    return this.run();
  }

  /** The value once the first read has landed: reads when none has, and holds the read it has. */
  async landed(): Promise<InstanceValue> {
    if (this.seq === 0) await this.refresh();
    return this.value;
  }

  /** For each file of the value it holds, by its path, which of its providers' copies are the
   *  same, or why a copy could not be read. */
  sameCopies(relativePaths: readonly string[]): Promise<FileCopies[]> {
    return this.copies.of(this.current, relativePaths);
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.changes.dispose();
    this.focus.dispose();
    this.subscribers = [];
    this.failureListeners = [];
  }

  private async readModFolders(): Promise<ModFolders | undefined> {
    const skipped = new Map<string, string>();
    const folders = await this.options.adapter.modFolders((name, reason) => skipped.set(name, reason));
    for (const [name, reason] of skipped) {
      if (!this.linksTold.has(name)) {
        this.options.log(`[instance] mods/${name} is a link Modbench cannot follow, so it is not a mod folder: ${reason}`);
      }
    }
    this.linksTold = new Set(skipped.keys());
    return folders;
  }

  // An unreadable Data folder is an answer, never a failed read: the whole value would otherwise
  // go stale over a folder outside the instance.
  private async readGameFolderPlugins(gameFolder: GameFolder): Promise<DataFolderPlugins> {
    const plugins = await this.options.adapter.gameFolderPlugins(gameFolder);
    if (plugins.kind === 'unreadable') this.options.log(`[instance] the game's Data folder could not be listed: ${plugins.reason}`);
    return plugins;
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
  // another tool is half-way through writing never empties the trees.
  private async recompute(): Promise<void> {
    let next: InstanceValue;
    try {
      next = await this.read();
    } catch (err) {
      const failure = errorMessage(err);
      this.options.logReadFailure(`[instance] Failed to read the instance: ${failure}`);
      this.failure = failure;
      this.notify(this.failureListeners, (listener) => listener());
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
        this.options.log(`[instance] subscriber threw at sequence ${this.seq}: ${errorMessage(err)}`);
      }
    }
  }

  private async readModOrder(profile: string): Promise<ModlistEntry[]> {
    const { adapter } = this.options;
    const entries = await adapter.modOrder(profile);
    return Promise.all(entries.map(async (entry) =>
      (entry.kind === 'mod' ? { ...entry, ...(await adapter.modMeta(entry.name)) } : entry)));
  }

  // A mod order read mid-write can parse to no entries, and zero mods is legal, so an empty one is
  // re-read after a settle before being believed. A partial parse reads as a real removal.
  private async readMods(profile: string): Promise<ModlistEntry[]> {
    const entries = await this.readModOrder(profile);
    if (entries.length > 0) return entries;
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    const confirmed = await this.readModOrder(profile);
    if (confirmed.length > 0) {
      this.options.log(`[instance] mod order read as empty mid-write; the re-read found ${confirmed.length} entries`);
    }
    return confirmed;
  }

  // Installed reads every mod folder, not one profile's mod order: a folder no profile has synced
  // into its mod order yet still owns its meta's claim. A separator is never installed from a
  // downloaded file.
  private async readInstalledInto(
    entries: readonly ModlistEntry[], modFolders: readonly ModFolder[],
  ): Promise<ReadonlyMap<string, readonly string[]>> {
    // Read once: an active-profile mod's archiveFilename is already in `entries`.
    const knownArchiveFilenames = new Map<string, string | undefined>();
    for (const entry of entries) if (entry.kind === 'mod') knownArchiveFilenames.set(entry.name, entry.archiveFilename);
    const metas = await Promise.all(modFolders.filter((folder) => folder.kind === 'mod').map(async ({ name }) => ({
      name,
      archiveFilename: knownArchiveFilenames.has(name)
        ? knownArchiveFilenames.get(name)
        : (await this.options.adapter.modMeta(name)).archiveFilename,
    })));
    return modsByInstallationFile(metas);
  }

  private async read(): Promise<InstanceValue> {
    const { adapter, log } = this.options;
    // The settings are read first and every later read is against the profile they name, so a
    // profile switch mid-recompute cannot mix one profile's mod order with another's plugin order.
    const settings = await adapter.settings();
    const { profile, gameName, gameRelease } = settings;
    const entries = await this.readMods(profile);
    const runtimeOutputRead = adapter.originFiles({ kind: 'runtimeOutput' });
    const [index, pluginOrder, downloadsOutcome, runtimeOutput, modFolders, profiles, game, trackedMods] = await Promise.all([
      runtimeOutputRead.then((output) => buildFileConflictIndex(entries, output.files, adapter, log)),
      adapter.pluginOrder(profile),
      // Both answers come from the settings read above, so a rewrite cannot land two generations
      // in one value.
      settings.downloadedFiles(),
      runtimeOutputRead,
      this.readModFolders(),
      adapter.profiles(),
      settings.gameFolder().then(async (gameFolder) => ({
        gameFolder,
        dataFolderPlugins: await this.readGameFolderPlugins(gameFolder),
        creationClub: await adapter.creationClubList(gameFolder, gameRelease),
      })),
      Promise.all(entries.map(async (entry) => (entry.kind === 'mod' && await adapter.modTracked(entry.name) ? [entry.name] : []))),
    ]);
    for (const note of runtimeOutput.notes) log(`[instance] ${runtimeOutput.origin}: ${note}`);
    const { gameFolder, dataFolderPlugins, creationClub } = game;
    const plugins = buildLoadOrderRows(pluginOrder, index, runtimeOutput.files, gameFolder);
    const pluginsLoadedWithNoLine = pluginsLoadedWithNoLineOf(gameMastersOf(gameRelease), creationClub, dataFolderPlugins, plugins);
    const installedInto = downloadsOutcome.kind === 'listed' && downloadsOutcome.files
      ? await this.readInstalledInto(entries, modFolders?.all ?? [])
      : undefined;
    const modFolderList = modFolders?.all;
    const syncSource = { activeProfile: profile, modFolders: modFolderList, plugins, dataFolderPlugins, pluginsLoadedWithNoLine };
    return {
      mods: entries,
      modFolders: modFolderList,
      trackedMods: new Set(trackedMods.flat()),
      profiles,
      files: index.files,
      filesByMod: index.filesByMod,
      foldersByMod: index.foldersByMod,
      plugins,
      downloads: downloadsOutcome.kind === 'unresolved'
        ? { kind: 'unresolved', reason: downloadsOutcome.reason }
        : {
          kind: 'listed',
          rows: downloadsOutcome.files && installedInto ? buildDownloadRows(downloadsOutcome.files, installedInto) : [],
        },
      activeProfile: profile,
      managerNames: adapter.names,
      gameName,
      gameRelease,
      nexusSlug: nexusSlugFor(gameRelease, gameName),
      gameFolder,
      dataFolderPlugins,
      pluginsLoadedWithNoLine,
      loadOrderSnapshot: loadOrderSnapshotOf({ plugins, gameFolder, pluginsLoadedWithNoLine }),
      overwriteFiles: runtimeOutput.files,
      overwriteFolders: runtimeOutput.folders,
      paths: pathsOf(runtimeOutput, downloadsOutcome, entries, modFolders),
      modSyncArguments: modSyncArgumentsOf(syncSource),
      pluginSyncArguments: pluginSyncArgumentsOf(syncSource),
    };
  }
}

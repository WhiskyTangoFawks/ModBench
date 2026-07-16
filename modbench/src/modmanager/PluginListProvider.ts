import * as vscode from 'vscode';
import type { IModlistSource, PluginEntry } from './model';
import type { Reporter } from './deployer';
import { dropIndexForMove } from './mo2/pluginsText';
import { buildFileConflictIndex } from './fileConflictIndex';
import { computePluginOrderStatuses, type PluginOrderStatus } from './statusChecker';
import { resolvePluginPaths } from './explicitSession';
import { discoverImplicitMasters } from './vanillaMasters';

const DND_MIME = 'application/vnd.medit.pluginlist-node';

/** Shared resolved-undefined default for an omitted `dataFolder` — hoisted out of
 *  the constructor so it isn't a fresh async operation per instance. */
const NO_DATA_FOLDER: Promise<string | undefined> = Promise.resolve(undefined);

/** Constructor options for {@link PluginListProvider}. Field order matches
 *  ModListProvider's identically-shaped options so the two siblings read the
 *  same (issue #80: replaces five positional args whose order diverged). */
export interface PluginListProviderOptions {
  source: IModlistSource;
  log?: (msg: string) => void;
  reporter?: Reporter;
  instanceRoot?: string;
  dataFolder?: Promise<string | undefined>;
}

/** A single plugins.txt line, with a native checkbox mirroring its `*` (enabled)
 *  state. Toggling the checkbox writes plugins.txt immediately (wired via the
 *  view's `onDidChangeCheckboxState` handler in extension.ts). An order-aware
 *  missing-master `status` (issue #67) overlays an error icon/description/tooltip
 *  when a declared master isn't loaded before this plugin — deliberately worded
 *  distinctly from the Mods tree's presence-only "Missing master:" badge. */
export class PluginNode extends vscode.TreeItem {
  readonly kind = 'plugin' as const;
  constructor(public readonly plugin: PluginEntry, status?: PluginOrderStatus) {
    super(plugin.name, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'plugin';
    this.checkboxState = plugin.enabled
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
    if (status?.kind === 'masterNotLoadedBefore') {
      const { masters } = status;
      this.iconPath = new vscode.ThemeIcon('error');
      this.description = masters.length === 1
        ? '✗ Master not loaded before this plugin'
        : `✗ ${masters.length} masters not loaded before this plugin`;
      this.tooltip = [plugin.name, ...masters.map((m) => `Master ${m} is not loaded before this plugin`)].join('\n');
    }
  }
}

/** A synthetic row for one of the game's implicitly-loaded vanilla/DLC masters
 *  (issue #108) — discovered from the resolved Data folder (a plugin file that
 *  is NOT a hardlink), never hardcoded. Rendered ahead of plugins.txt's own
 *  rows, in topological order. Immutable: no checkbox (unset, so VS Code
 *  renders none — nothing to toggle), and excluded from drag by
 *  `handleDrag`'s existing `kind === 'plugin'` filter (not draggable). Its
 *  `contextValue` (`pluginImplicit`, distinct from `plugin`) lets package.json
 *  menu `when` clauses hide any plugin-only command (reorder, toggle) for it. */
export class ImplicitMasterNode extends vscode.TreeItem {
  readonly kind = 'implicitMaster' as const;
  constructor(public readonly name: string) {
    super(name, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'pluginImplicit';
  }
}

/** Inline error surface: shown instead of an empty list when the plugins.txt
 *  read fails, so a failure is never indistinguishable from "no plugins"
 *  (ADR-0026, modmanager/CLAUDE.md convention). */
export class ErrorNode extends vscode.TreeItem {
  readonly kind = 'error' as const;
  constructor(message: string) {
    super(`⚠ Failed to load: ${message}`, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'error';
    this.tooltip = message;
    this.iconPath = new vscode.ThemeIcon('error');
  }
}

/** Empty state: a single informational row when plugins.txt has no lines. */
export class EmptyNode extends vscode.TreeItem {
  readonly kind = 'empty' as const;
  constructor() {
    super('No plugins', vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon('check');
  }
}

export type PluginListNode = PluginNode | ImplicitMasterNode | ErrorNode | EmptyNode;

/** Sidebar Plugin List (Loadout) tree: one row per plugins.txt line, in Plugin
 *  load order (top = loads first). Toggling a row's checkbox writes plugins.txt
 *  immediately via `setPluginEnabled`. */
export class PluginListProvider
  implements vscode.TreeDataProvider<PluginListNode>, vscode.TreeDragAndDropController<PluginListNode>
{
  readonly dropMimeTypes = [DND_MIME] as const;
  readonly dragMimeTypes = [DND_MIME] as const;

  private readonly _onDidChangeTreeData = new vscode.EventEmitter<PluginListNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly source: IModlistSource;
  private readonly log: (msg: string) => void;
  private readonly reporter?: Reporter;
  private readonly instanceRoot?: string;
  private readonly dataFolder: Promise<string | undefined>;
  /** The last rendered plugin order, so a drop computes its index against exactly
   *  what the user dragged against (not a fresh read that an external edit could skew).
   *  A separate concern from `cache` below — this is plugins.txt's raw file order
   *  (what drop-index math writes against), not the full display row set. */
  private lastOrder: string[] = [];
  /** Active title-bar filter (case-insensitive substring on plugin name); empty = off. */
  private filterText = '';
  private filterLower = '';
  /** Issue #79: caches the unfiltered computed row list (implicit masters +
   *  PluginNodes with badges) so a filter keystroke re-renders instead of
   *  re-reading plugins.txt / re-walking the conflict index and status pass.
   *  `invalidate()` clears it; `render()` (setFilter) leaves it intact. */
  private cache?: { rows: PluginListNode[] };

  /** `instanceRoot`, when provided, enables the order-aware missing-master badge
   *  (issue #67): each plugin's declared masters are read and checked against the
   *  Plugin load order. Omitted in tests using an in-memory-only source.
   *  `dataFolder` is the game's resolved Data folder (the single GameDirectory
   *  resolved once at the composition root, #78) — for locating vanilla/DLC/CC
   *  plugins no mod ships; a resolved `Promise<undefined>` degrades those lookups. */
  constructor(options: PluginListProviderOptions) {
    this.source = options.source;
    this.log = options.log ?? (() => {});
    this.reporter = options.reporter;
    this.instanceRoot = options.instanceRoot;
    this.dataFolder = options.dataFolder ?? NO_DATA_FOLDER;
  }

  /** Clears the cached row set and re-renders — a mutation (toggle, drop, ...)
   *  invalidated what's on disk, so the next `getChildren()` must re-read
   *  plugins.txt/enabled state. Also the title-bar Refresh button's action.
   *  Issue #79: distinct from `render()`, which only re-renders already-built rows. */
  invalidate(): void {
    this.cache = undefined;
    this._onDidChangeTreeData.fire(undefined);
  }

  /** Re-renders already-built rows without touching the cache. Issue #79: the
   *  only call site is `setFilter` — a filter keystroke never changes what's on
   *  disk, so it must not force a re-read of plugins.txt/enabled state. */
  private render(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  /** Set the title-bar filter (empty string clears it) and re-render. Narrows the
   *  rendered rows to plugins whose name contains `text`, case-insensitively —
   *  the same transient-InputBox pattern used across every Modbench list surface.
   *  Render-only (#79): the filter narrows which already-built rows show — it
   *  never invalidates the cache. */
  setFilter(text: string): void {
    this.filterText = text;
    this.filterLower = text.toLowerCase();
    this.render();
  }

  /** Toggle a plugin's `*` (enabled) state, writing plugins.txt immediately, then
   *  invalidate so the tree re-reads the persisted state. */
  async setPluginEnabled(pluginName: string, enabled: boolean): Promise<void> {
    await this.source.setPluginEnabled(pluginName, enabled);
    this.invalidate();
  }

  /** Resolve a plugin NAME to its winning physical path — the MO2-priority
   *  FileConflictIndex winner for a mod-provided plugin, else the game's Data
   *  folder for an unmanaged vanilla/DLC/CC plugin (the same resolution the
   *  editing-session builder performs via `resolvePluginPaths`). Used by the
   *  Reveal in Explorer row action (issue #69). Returns undefined when no
   *  instanceRoot is configured or resolution fails (ini/index unreadable) — a
   *  fresh read each call, since reveal is a rare explicit action. */
  async resolvePluginPath(name: string): Promise<string | undefined> {
    if (!this.instanceRoot) return undefined;
    try {
      const entries = await this.source.readModlist();
      const index = await buildFileConflictIndex(entries, this.instanceRoot);
      const dataFolder = await this.dataFolder;
      if (!dataFolder) return undefined;
      return resolvePluginPaths([name], index, dataFolder).get(name);
    } catch (e) {
      this.log(`[PluginListProvider] resolvePluginPath("${name}") failed: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    }
  }

  getTreeItem(element: PluginListNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: PluginListNode): Promise<PluginListNode[]> {
    if (element) return []; // flat list — rows have no children

    if (!this.cache) {
      const built = await this.buildRows();
      if (built.kind === 'error') return [new ErrorNode(built.message)];
      if (built.kind === 'empty') return [new EmptyNode()];
      this.cache = built.cache;
    }

    // Rows here are always PluginNode/ImplicitMasterNode, both constructed with a
    // plain string label — safe to filter on directly (never TreeItemLabel/object).
    return this.filterText
      ? this.cache.rows.filter((n) => (n.label as string).toLowerCase().includes(this.filterLower))
      : this.cache.rows;
  }

  /** Reads plugins.txt/enabled state and computes the full unfiltered row set
   *  (issue #79: the cache-population path, run only on a cache miss). Returns a
   *  discriminated result rather than caching an error/empty placeholder, so a
   *  transient read failure or a momentarily-empty plugins.txt never sticks
   *  around as stale cached state. */
  private async buildRows(): Promise<
    | { kind: 'error'; message: string }
    | { kind: 'empty' }
    | { kind: 'ok'; cache: { rows: PluginListNode[] } }
  > {
    let order: string[];
    let enabled: string[];
    try {
      [order, enabled] = await Promise.all([
        this.source.readPluginOrder(),
        this.source.readEnabledPlugins(),
      ]);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.log(`[PluginListProvider] readPluginOrder failed: ${message}`);
      return { kind: 'error', message };
    }

    this.lastOrder = order;

    // The game's implicitly-loaded vanilla/DLC masters (issue #108): discovered from
    // the resolved Data folder, never from plugins.txt. Rendered first, immutable. A
    // name in both sets renders exactly once — as the implicit row — so its
    // plugins.txt line (if any, e.g. a stale CC .esl entry) is filtered out here.
    // `fullOrder` (implicit-first) is used for row rendering and badge computation
    // ONLY; `this.lastOrder` above stays plugins.txt's raw order, since that's what
    // `dropIndexForMove`/`reorderPlugins` write positions against.
    const dataFolder = await this.dataFolder;
    const implicitNames = await discoverImplicitMasters(dataFolder, this.log);
    const implicitLower = new Set(implicitNames.map((n) => n.toLowerCase()));
    const dedupedOrder = order.filter((n) => !implicitLower.has(n.toLowerCase()));
    const fullOrder = [...implicitNames, ...dedupedOrder];

    if (fullOrder.length === 0) return { kind: 'empty' };
    const enabledSet = new Set(enabled);
    // Badges are computed against the full order (never the filtered subset) so a
    // filtered-out master still counts toward a visible row's order-aware verdict.
    const statuses = await this.computeStatuses(fullOrder);
    const rows: PluginListNode[] = [
      ...implicitNames.map((name) => new ImplicitMasterNode(name)),
      ...dedupedOrder.map((name) => new PluginNode({ name, enabled: enabledSet.has(name) }, statuses?.get(name))),
    ];
    return { kind: 'ok', cache: { rows } };
  }

  /** Order-aware missing-master verdicts for `order` (the implicit-first, deduped
   *  full row order — see `getChildren`), or undefined when no instanceRoot is
   *  configured. A secondary, non-blocking step (modmanager/CLAUDE.md): on any
   *  failure the badges degrade to absent — the tree still renders every row —
   *  with a warning surfaced (ADR-0026: silently missing badges would look
   *  identical to "all masters correctly ordered"). */
  private async computeStatuses(order: string[]): Promise<Map<string, PluginOrderStatus> | undefined> {
    if (!this.instanceRoot) return undefined;
    try {
      const entries = await this.source.readModlist();
      const index = await buildFileConflictIndex(entries, this.instanceRoot);
      const dataFolder = await this.dataFolder;
      return await computePluginOrderStatuses(order, index, dataFolder, this.log);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.log(`[PluginListProvider] master-order status computation failed: ${message}`);
      this.reporter?.report('warning', 'Could not compute plugin master-order status — badges may be inaccurate.', message);
      return undefined;
    }
  }

  /** Serialise the dragged selection. VS Code passes the whole selection when the
   *  grabbed row is part of it (an unselected grab collapses to a single-item
   *  selection), so `source` is the full block to move. Non-plugin rows can't move. */
  handleDrag(
    source: readonly PluginListNode[],
    dataTransfer: vscode.DataTransfer,
    _token: vscode.CancellationToken,
  ): void {
    const names = source.filter((n): n is PluginNode => n.kind === 'plugin').map((n) => n.plugin.name);
    if (names.length === 0) return;
    dataTransfer.set(DND_MIME, new vscode.DataTransferItem({ names }));
  }

  /** Move the dragged block so it lands before `target` (or at the end when the
   *  drop is past the last row / onto a non-plugin node), writing plugins.txt
   *  immediately. `dropIndexForMove` reconciles the drop target with
   *  `movePluginsInText`'s post-removal index convention. A drop onto the
   *  immutable implicit-master block (issue #108) is not a plugins.txt position —
   *  those rows have no line — so it lands at file-index 0, the top of the
   *  mutable region, computed against `this.lastOrder` (plugins.txt's raw order,
   *  NEVER the display-composed implicit-first order — writing against the
   *  wrong index would corrupt plugins.txt). */
  async handleDrop(
    target: PluginListNode | undefined,
    dataTransfer: vscode.DataTransfer,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    const payload = dataTransfer.get(DND_MIME);
    if (!payload) return;
    const { names } = payload.value as { names: string[] };
    if (names.length === 0) return;
    const targetName = target?.kind === 'plugin' ? target.plugin.name : undefined;
    const toIndex = target?.kind === 'implicitMaster' ? 0 : dropIndexForMove(this.lastOrder, names, targetName);
    try {
      await this.source.reorderPlugins(names, toIndex);
    } catch (e) {
      // ADR-0026: an explicit user action failed — notify + log, then resync the
      // moved rows against disk so the tree never shows a phantom reorder.
      const message = e instanceof Error ? e.message : String(e);
      this.log(`[PluginListProvider] reorderPlugins failed: ${message}`);
      this.reporter?.report('error', 'Failed to reorder plugins.', message);
    }
    this.invalidate();
  }
}

import * as vscode from 'vscode';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { IModlistSource, PluginEntry } from './model';
import type { Reporter } from './deployer';
import { dropIndexForMove } from './mo2/pluginsText';
import { buildFileConflictIndex } from './fileConflictIndex';
import { computePluginOrderStatuses, type PluginOrderStatus } from './statusChecker';
import { resolvePluginPaths } from './explicitSession';
import { readGamePath } from './mo2/modOrganizerIni';
import { normalizeGamePath } from './gameDirectory';

const DND_MIME = 'application/vnd.medit.pluginlist-node';

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

export type PluginListNode = PluginNode | ErrorNode | EmptyNode;

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

  private readonly log: (msg: string) => void;
  /** The last rendered plugin order, so a drop computes its index against exactly
   *  what the user dragged against (not a fresh read that an external edit could skew). */
  private lastOrder: string[] = [];
  /** Active title-bar filter (case-insensitive substring on plugin name); empty = off. */
  private filterText = '';
  private filterLower = '';

  /** `instanceRoot`, when provided, enables the order-aware missing-master badge
   *  (issue #67): each plugin's declared masters are read and checked against the
   *  Plugin load order. Omitted in tests using an in-memory-only source. */
  constructor(
    private readonly source: IModlistSource,
    log?: (msg: string) => void,
    private readonly reporter?: Reporter,
    private readonly instanceRoot?: string,
  ) {
    this.log = log ?? (() => {});
  }

  /** Force a re-read of plugins.txt (the title-bar Refresh button). */
  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  /** Set the title-bar filter (empty string clears it) and refresh. Narrows the
   *  rendered rows to plugins whose name contains `text`, case-insensitively —
   *  the same transient-InputBox pattern used across every Modbench list surface. */
  setFilter(text: string): void {
    this.filterText = text;
    this.filterLower = text.toLowerCase();
    this.refresh();
  }

  /** Toggle a plugin's `*` (enabled) state, writing plugins.txt immediately, then
   *  refresh so the tree re-reads the persisted state. */
  async setPluginEnabled(pluginName: string, enabled: boolean): Promise<void> {
    await this.source.setPluginEnabled(pluginName, enabled);
    this.refresh();
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
      const dataFolder = await this.resolveDataFolder(this.instanceRoot);
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
      return [new ErrorNode(message)];
    }

    this.lastOrder = order;
    if (order.length === 0) return [new EmptyNode()];
    const enabledSet = new Set(enabled);
    // Badges are computed against the full order (never the filtered subset) so a
    // filtered-out master still counts toward a visible row's order-aware verdict.
    const statuses = await this.computeStatuses(order);
    const rows = order.map((name) => new PluginNode({ name, enabled: enabledSet.has(name) }, statuses?.get(name)));
    return this.filterText ? rows.filter((n) => n.plugin.name.toLowerCase().includes(this.filterLower)) : rows;
  }

  /** Order-aware missing-master verdicts for the current order, or undefined when
   *  no instanceRoot is configured. A secondary, non-blocking step (modmanager/
   *  CLAUDE.md): on any failure the badges degrade to absent — the tree still
   *  renders every row — with a warning surfaced (ADR-0026: silently missing
   *  badges would look identical to "all masters correctly ordered"). */
  private async computeStatuses(order: string[]): Promise<Map<string, PluginOrderStatus> | undefined> {
    if (!this.instanceRoot) return undefined;
    try {
      const entries = await this.source.readModlist();
      const index = await buildFileConflictIndex(entries, this.instanceRoot);
      const dataFolder = await this.resolveDataFolder(this.instanceRoot);
      return await computePluginOrderStatuses(order, index, dataFolder, this.log);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.log(`[PluginListProvider] master-order status computation failed: ${message}`);
      this.reporter?.report('warning', 'Could not compute plugin master-order status — badges may be inaccurate.', message);
      return undefined;
    }
  }

  /** The game's Data folder (for resolving vanilla/DLC/CC plugins no mod ships),
   *  from MO2's own gamePath — Wine-normalized like vanillaMasters.ts. Undefined
   *  when the ini is absent/unreadable: vanilla-row master lookups then degrade,
   *  mod-provided ones still resolve. */
  private async resolveDataFolder(instanceRoot: string): Promise<string | undefined> {
    try {
      const iniText = await readFile(join(instanceRoot, 'ModOrganizer.ini'), 'utf8');
      return join(normalizeGamePath(readGamePath(iniText)), 'Data');
    } catch (e) {
      this.log(`[PluginListProvider] could not resolve the game Data folder: ${e instanceof Error ? e.message : String(e)}`);
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
   *  `movePluginsInText`'s post-removal index convention. */
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
    const toIndex = dropIndexForMove(this.lastOrder, names, targetName);
    try {
      await this.source.reorderPlugins(names, toIndex);
    } catch (e) {
      // ADR-0026: an explicit user action failed — notify + log, then resync the
      // moved rows against disk so the tree never shows a phantom reorder.
      const message = e instanceof Error ? e.message : String(e);
      this.log(`[PluginListProvider] reorderPlugins failed: ${message}`);
      this.reporter?.report('error', 'Failed to reorder plugins.', message);
    }
    this.refresh();
  }
}

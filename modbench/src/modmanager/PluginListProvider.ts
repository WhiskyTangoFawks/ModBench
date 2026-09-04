import * as vscode from 'vscode';
import { join } from 'node:path';
import type { IModlistSource, PluginEntry } from './model';
import type { Reporter } from './deployer';
import { dropIndexForMove } from './mo2/pluginsText';
import {
  buildFileConflictIndex,
  rootLevelWinners,
  type FileConflictIndex,
} from './fileConflictIndex';
import { computePluginOrderStatuses, type PluginOrderStatus } from './statusChecker';
import { resolvePluginPaths } from './loadOrderSnapshot';
import { discoverImplicitMasters } from './vanillaMasters';
import { ErrorNode } from './ErrorNode';

const DND_MIME = 'application/vnd.medit.pluginlist-node';

// Hoisted out of the constructor so an omitted `dataFolder` is not a fresh closure per instance.
const NO_DATA_FOLDER: () => Promise<string | undefined> = () => Promise.resolve(undefined);

export type PluginListSource = Pick<
  IModlistSource, 'setPluginEnabled' | 'readModlist' | 'readPluginOrder' | 'readEnabledPlugins' | 'reorderPlugins'
>;

/** `dataFolder` is a getter, not a settled `Promise`: the setting it resolves is editable while
 *  Modbench runs, so a value captured at construction could go stale for the provider's life. */
export interface PluginListProviderOptions {
  source: PluginListSource;
  log?: (msg: string) => void;
  reporter?: Reporter;
  instanceRoot?: string;
  dataFolder?: () => Promise<string | undefined>;
}

/** No `resourceUri`: VS Code infers a base icon from one unless `iconPath` overrides it, so
 *  setting one would silently change every row's icon. Losing copies are registered
 *  (ADR-0044), not displayed. */
export class PluginNode extends vscode.TreeItem {
  readonly kind = 'plugin' as const;
  constructor(
    public readonly plugin: PluginEntry,
    public readonly orderStatus?: PluginOrderStatus,
  ) {
    super(plugin.name, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'plugin';
    // xEdit parity: selecting a plugin node shows its File Header, with no separate affordance.
    // Routed through the `modbench.openHeader` bridge command because this provider is forbidden
    // Editing's own vocabulary, which the composition root owns instead.
    this.command = { command: 'modbench.openHeader', title: 'Open Header', arguments: [this] };
    this.checkboxState = plugin.enabled
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
    if (orderStatus?.kind === 'masterNotLoadedBefore') {
      const { masters } = orderStatus;
      this.iconPath = new vscode.ThemeIcon('error');
      this.description = masters.length === 1
        ? '✗ Master not loaded before this plugin'
        : `✗ ${masters.length} masters not loaded before this plugin`;
      this.tooltip = [plugin.name, ...masters.map((m) => `Master ${m} is not loaded before this plugin`)].join('\n');
    }
  }
}

/** Structured access to what the row otherwise bakes into icon, description and tooltip text,
 *  so a caller can dedupe by master name without parsing that text (ADR-0037). */
export function orderIssueMastersOf(node: PluginListNode): string[] | undefined {
  return node.kind === 'plugin' && node.orderStatus?.kind === 'masterNotLoadedBefore'
    ? node.orderStatus.masters
    : undefined;
}

/** MO2's checked-but-disabled checkbox is not reproducible: `TreeItemCheckboxState` has no
 *  non-interactive variant, so a rendered checkbox would invite a toggle the extension must
 *  revert. A lock substitutes (ADR-0035). */
export class ImplicitMasterNode extends vscode.TreeItem {
  readonly kind = 'implicitMaster' as const;
  constructor(public readonly name: string, path?: string) {
    super(name, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'pluginImplicit';
    this.iconPath = new vscode.ThemeIcon('lock');
    this.tooltip = [name, "This plugin can't be disabled or moved (enforced by the game)."].join('\n');
    // See PluginNode's own comment above for why this routes through the modbench.openHeader
    // bridge command rather than building the header panel's target directly here.
    this.command = { command: 'modbench.openHeader', title: 'Open Header', arguments: [this] };
    if (path !== undefined) this.resourceUri = vscode.Uri.file(path);
  }
}

export class EmptyNode extends vscode.TreeItem {
  readonly kind = 'empty' as const;
  constructor() {
    super('No plugins', vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon('check');
  }
}

export type PluginListNode = PluginNode | ImplicitMasterNode | ErrorNode | EmptyNode;

// The view is shared, so a drop must be able to tell these rows from another provider's.
const OWN_ROW_KINDS = new Set<string>(['plugin', 'implicitMaster', 'error', 'empty']);

/** The plugin file a row stands for, undefined for the error and empty-state rows. The boundary
 *  object CONTEXT-MAP.md names — the only thing about these rows anything outside Mod
 *  Management needs to know. */
export function pluginFileOf(node: PluginListNode): string | undefined {
  if (node.kind === 'plugin') return node.plugin.name;
  if (node.kind === 'implicitMaster') return node.name;
  return undefined;
}

/** Fired only from a real toggle, never a generic re-render, which carries nothing to apply.
 *  Mod Management never calls the backend, so this event is where its knowledge ends
 *  (ADR-0035). */
export interface PluginParticipationChange {
  plugin: string;
  enabled: boolean;
}

/** One row per plugins.txt line, in Plugin load order. */
export class PluginListProvider
  implements vscode.TreeDataProvider<PluginListNode>, vscode.TreeDragAndDropController<PluginListNode>
{
  readonly dropMimeTypes = [DND_MIME] as const;
  readonly dragMimeTypes = [DND_MIME] as const;

  private readonly _onDidChangeTreeData = new vscode.EventEmitter<PluginListNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  // Distinct from onDidChangeTreeData: see PluginParticipationChange.
  private readonly _onDidChangeParticipation = new vscode.EventEmitter<PluginParticipationChange>();
  readonly onDidChangeParticipation = this._onDidChangeParticipation.event;

  private readonly source: PluginListSource;
  private readonly log: (msg: string) => void;
  private readonly reporter?: Reporter;
  private readonly instanceRoot?: string;
  private readonly dataFolder: () => Promise<string | undefined>;
  // plugins.txt's raw file order as last rendered, so a drop computes its index against what
  // the user dragged against rather than a fresh read an external edit could skew.
  private lastOrder: string[] = [];
  private filterText = '';
  private filterLower = '';
  // Unfiltered rows, so a filter keystroke re-renders instead of re-reading plugins.txt and
  // re-walking the conflict index. `invalidate()` clears it; `render()` leaves it intact.
  private cache?: { rows: PluginListNode[] };

  /** `instanceRoot` enables the order-aware missing-master badge and is omitted by tests using
   *  an in-memory source; an undefined `dataFolder` degrades the vanilla-plugin lookups. */
  constructor(options: PluginListProviderOptions) {
    this.source = options.source;
    this.log = options.log ?? (() => {});
    this.reporter = options.reporter;
    this.instanceRoot = options.instanceRoot;
    this.dataFolder = options.dataFolder ?? NO_DATA_FOLDER;
  }

  invalidate(): void {
    this.cache = undefined;
    this._onDidChangeTreeData.fire(undefined);
  }

  // A filter keystroke changes nothing on disk, so it must not force a re-read.
  private render(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  /** Case-insensitive substring on plugin name; an empty string clears it. Render-only, so the
   *  cache survives. */
  setFilter(text: string): void {
    this.filterText = text;
    this.filterLower = text.toLowerCase();
    this.render();
  }

  /** The write reads plugins.txt fresh rather than trusting this provider's possibly stale row
   *  cache; a name whose line has meanwhile gone is a no-op. */
  async setPluginEnabled(pluginName: string, enabled: boolean): Promise<void> {
    await this.source.setPluginEnabled(pluginName, enabled);
    this.invalidate();
    this._onDidChangeParticipation.fire({ plugin: pluginName, enabled });
  }

  /** The winning copy in the Mod override order, else the game's Data folder for a plugin no
   *  mod provides. Undefined when resolution fails; a fresh read each call, since the one
   *  caller is a rare explicit action. */
  async resolvePluginPath(name: string): Promise<string | undefined> {
    if (!this.instanceRoot) return undefined;
    try {
      const entries = await this.source.readModlist();
      const index = await buildFileConflictIndex(entries, this.instanceRoot, this.log);
      const dataFolder = await this.dataFolder();
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

  // Returns a discriminated result rather than caching an error or empty placeholder, so a
  // transient read failure never sticks around as stale cached state.
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

    // A name in both sets renders once, as the implicit row. `fullOrder` is display and badge
    // order only: `this.lastOrder` stays plugins.txt's raw order, which is what write positions
    // are computed against.
    const dataFolder = await this.dataFolder();
    const implicitNames = await discoverImplicitMasters(dataFolder, this.log);
    const implicitLower = new Set(implicitNames.map((n) => n.toLowerCase()));
    const dedupedOrder = order.filter((n) => !implicitLower.has(n.toLowerCase()));

    // Rows are exactly plugins.txt's lines: a plugin file on disk with no line is the plugins
    // reconcile's business, never merged in here.
    const index = await this.buildFileIndex();
    const winnerByName = index ? rootLevelWinners(index) : undefined;
    const fullOrder = [...implicitNames, ...dedupedOrder];

    if (fullOrder.length === 0) return { kind: 'empty' };
    const enabledSet = new Set(enabled);
    // Badges are computed against the full order (never the filtered subset) so a
    // filtered-out master still counts toward a visible row's order-aware verdict.
    const statuses = winnerByName ? await this.computeOrderStatuses(fullOrder, winnerByName, dataFolder) : undefined;
    this.lastImplicitNames = new Set(implicitNames.map((n) => n.toLowerCase()));
    const rows: PluginListNode[] = [
      ...implicitNames.map((name) => new ImplicitMasterNode(name, dataFolder ? join(dataFolder, name) : undefined)),
      ...dedupedOrder.map((name) => new PluginNode({ name, enabled: enabledSet.has(name) }, statuses?.get(name))),
    ];
    return { kind: 'ok', cache: { rows } };
  }

  /** Lowercased, and empty before the first render. A live read, not a snapshot. */
  implicitMasterNames(): ReadonlySet<string> {
    return this.lastImplicitNames;
  }

  private lastImplicitNames: ReadonlySet<string> = new Set();

  // A secondary, non-blocking step: on failure the tree still renders every plugins.txt line,
  // without badges. The loss is reported because a missing badge looks like "nothing to flag".
  private async buildFileIndex(): Promise<FileConflictIndex | undefined> {
    if (!this.instanceRoot) return undefined;
    try {
      const entries = await this.source.readModlist();
      return await buildFileConflictIndex(entries, this.instanceRoot, this.log);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.log(`[PluginListProvider] file index build failed (badges degrade): ${message}`);
      this.reporter?.report(
        'warning',
        'Could not read mod files on disk — plugin master-order badges may be inaccurate.',
        message,
      );
      return undefined;
    }
  }

  // `winnerByName` is built once by the caller: a full scan across every mod's files, not free
  // to repeat. Its own try/catch, so a badge failure never takes away rows already found.
  private async computeOrderStatuses(
    order: string[], winnerByName: Map<string, string>, dataFolder: string | undefined,
  ): Promise<Map<string, PluginOrderStatus> | undefined> {
    try {
      return await computePluginOrderStatuses(order, winnerByName, dataFolder, this.log);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.log(`[PluginListProvider] master-order status computation failed: ${message}`);
      this.reporter?.report('warning', 'Could not compute plugin master-order status — badges may be inaccurate.', message);
      return undefined;
    }
  }

  /** VS Code passes the whole selection when the grabbed row is part of it, so `source` is the
   *  full block to move. Non-plugin rows cannot move. */
  handleDrag(
    source: readonly PluginListNode[],
    dataTransfer: vscode.DataTransfer,
    _token: vscode.CancellationToken,
  ): void {
    const names = source.filter((n): n is PluginNode => n.kind === 'plugin').map((n) => n.plugin.name);
    if (names.length === 0) return;
    dataTransfer.set(DND_MIME, new vscode.DataTransferItem({ names }));
  }

  /** The block lands before `target`, or at the end past the last row. A drop onto the implicit
   *  masters is no plugins.txt position — those rows have no line — so it lands at file
   *  index 0. */
  async handleDrop(
    target: PluginListNode | undefined,
    dataTransfer: vscode.DataTransfer,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    const payload = dataTransfer.get(DND_MIME);
    if (!payload) return;
    const { names } = payload.value as { names: string[] };
    if (names.length === 0) return;
    const toIndex = this.dropIndexFor(target, names);
    if (toIndex === undefined) return;
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

  // VS Code can hand the drop a row this controller never produced, and "not one of my rows" is
  // not "past the last row" — the latter means the losing end, so a foreign row must not fall
  // through to it.
  private dropIndexFor(target: PluginListNode | undefined, names: string[]): number | undefined {
    if (target !== undefined && !OWN_ROW_KINDS.has(target.kind)) return undefined;
    if (target?.kind === 'implicitMaster') return 0;
    const targetName = target?.kind === 'plugin' ? target.plugin.name : undefined;
    return dropIndexForMove(this.lastOrder, names, targetName);
  }
}

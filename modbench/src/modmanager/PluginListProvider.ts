import * as vscode from 'vscode';
import type { IModlistSource, PluginEntry } from './model';
import type { Reporter } from './deployer';
import { dropIndexForMove } from './mo2/pluginsText';

const DND_MIME = 'application/vnd.medit.pluginlist-node';

/** A single plugins.txt line, with a native checkbox mirroring its `*` (enabled)
 *  state. Toggling the checkbox writes plugins.txt immediately (wired via the
 *  view's `onDidChangeCheckboxState` handler in extension.ts). */
export class PluginNode extends vscode.TreeItem {
  readonly kind = 'plugin' as const;
  constructor(public readonly plugin: PluginEntry) {
    super(plugin.name, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'plugin';
    this.checkboxState = plugin.enabled
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
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

  constructor(
    private readonly source: IModlistSource,
    log?: (msg: string) => void,
    private readonly reporter?: Reporter,
  ) {
    this.log = log ?? (() => {});
  }

  /** Force a re-read of plugins.txt (the title-bar Refresh button). */
  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  /** Toggle a plugin's `*` (enabled) state, writing plugins.txt immediately, then
   *  refresh so the tree re-reads the persisted state. */
  async setPluginEnabled(pluginName: string, enabled: boolean): Promise<void> {
    await this.source.setPluginEnabled(pluginName, enabled);
    this.refresh();
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
    return order.map((name) => new PluginNode({ name, enabled: enabledSet.has(name) }));
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

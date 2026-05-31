import * as vscode from 'vscode';
import type { PluginMetadata, RecordSummary } from './ApiClient';
import type { PluginRepository } from './PluginRepository';

const PAGE_SIZE = 50;

export class PluginNode extends vscode.TreeItem {
  readonly kind = 'plugin' as const;
  constructor(public readonly plugin: PluginMetadata) {
    super(plugin.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.description = `[${plugin.loadOrderIndex}] ${plugin.recordCount.toLocaleString()} records`;
    this.tooltip = plugin.path;
    this.contextValue = plugin.isImmutable ? 'pluginImmutable' : 'plugin';
    if (plugin.isImmutable) {
      this.iconPath = new vscode.ThemeIcon('lock');
    }
  }
}

export class RecordTypeNode extends vscode.TreeItem {
  readonly kind = 'recordType' as const;
  constructor(
    public readonly plugin: string,
    public readonly recordType: string,
    count: number,
  ) {
    super(recordType, vscode.TreeItemCollapsibleState.Collapsed);
    this.description = count.toLocaleString();
    this.contextValue = 'recordType';
  }
}

export class RecordNode extends vscode.TreeItem {
  readonly kind = 'record' as const;
  constructor(public readonly record: RecordSummary) {
    const label = record.editorId ? `${record.editorId} [${record.formKey}]` : record.formKey;
    super(label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'record';
    this.command = {
      command: 'mEdit.openEditor',
      title: 'Open Record',
      arguments: [{ formKey: record.formKey, label }],
    };
  }
}

export class LoadMoreNode extends vscode.TreeItem {
  readonly kind = 'loadMore' as const;
  constructor(public readonly parentNode: RecordTypeNode, remaining: number) {
    super(`$(sync) Load more… (${remaining.toLocaleString()} remaining)`, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'loadMore';
    this.command = {
      command: 'mEdit.loadMore',
      title: 'Load More',
      arguments: [this],
    };
  }
}

export type PluginTreeNode = PluginNode | RecordTypeNode | RecordNode | LoadMoreNode;

type PageCache = Map<string, { items: RecordSummary[]; total: number }>;

export class PluginTreeProvider implements vscode.TreeDataProvider<PluginTreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<PluginTreeNode | undefined | null>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly pageCache: PageCache = new Map();

  constructor(private readonly repository: PluginRepository) {}

  refresh(): void {
    this.pageCache.clear();
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: PluginTreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: PluginTreeNode): Promise<PluginTreeNode[]> {
    if (!element) return this.fetchPlugins();
    if (element instanceof PluginNode) return this.fetchRecordTypes(element);
    if (element instanceof RecordTypeNode) return this.fetchRecords(element);
    return [];
  }

  async loadMore(node: LoadMoreNode): Promise<void> {
    const parent = node.parentNode;
    const cacheKey = this.cacheKey(parent);
    const cached = this.pageCache.get(cacheKey) ?? { items: [], total: 0 };
    try {
      const result = await this.repository.getRecords(
        parent.plugin, parent.recordType, cached.items.length, PAGE_SIZE,
      );
      this.pageCache.set(cacheKey, {
        items: [...cached.items, ...result.items],
        total: result.total,
      });
    } catch {
      // leave cache as-is
    }
    this._onDidChangeTreeData.fire(parent);
  }

  private cacheKey(node: RecordTypeNode): string {
    return `${node.plugin}::${node.recordType}`;
  }

  private async fetchPlugins(): Promise<PluginNode[]> {
    try {
      const plugins = await this.repository.getPlugins();
      return plugins.map(p => new PluginNode(p));
    } catch {
      return [];
    }
  }

  private async fetchRecordTypes(node: PluginNode): Promise<RecordTypeNode[]> {
    try {
      const types = await this.repository.getRecordTypes(node.plugin.name);
      return types.map(t => new RecordTypeNode(node.plugin.name, t.type, t.count));
    } catch {
      return [];
    }
  }

  private async fetchRecords(node: RecordTypeNode): Promise<(RecordNode | LoadMoreNode)[]> {
    const cacheKey = this.cacheKey(node);
    let cached = this.pageCache.get(cacheKey);
    if (!cached) {
      try {
        cached = await this.repository.getRecords(node.plugin, node.recordType, 0, PAGE_SIZE);
        this.pageCache.set(cacheKey, cached);
      } catch {
        return [];
      }
    }

    const nodes: (RecordNode | LoadMoreNode)[] = cached.items.map(r => new RecordNode(r));
    if (cached.total > cached.items.length) {
      nodes.push(new LoadMoreNode(node, cached.total - cached.items.length));
    }
    return nodes;
  }
}

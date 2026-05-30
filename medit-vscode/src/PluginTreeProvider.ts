import * as vscode from 'vscode';
import type { ApiClient, PluginMetadata, RecordSummary } from './ApiClient';

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

export class PluginTreeProvider implements vscode.TreeDataProvider<PluginTreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<PluginTreeNode | undefined | null>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly pageCache = new Map<RecordTypeNode, { items: RecordSummary[]; total: number }>();

  constructor(private readonly client: ApiClient) {}

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
    const cached = this.pageCache.get(parent) ?? { items: [], total: 0 };
    try {
      const { data } = await this.client.GET('/records', {
        params: {
          query: {
            plugin: parent.plugin,
            type: parent.recordType,
            limit: PAGE_SIZE,
            offset: cached.items.length,
          },
        },
      });
      const result = data as { items: RecordSummary[]; total: number } | undefined;
      if (result) {
        cached.items = [...cached.items, ...result.items];
        cached.total = result.total;
        this.pageCache.set(parent, cached);
      }
    } catch {
      // leave cache as-is
    }
    this._onDidChangeTreeData.fire(parent);
  }

  private async fetchPlugins(): Promise<PluginNode[]> {
    try {
      const { data } = await this.client.GET('/plugins', {});
      const plugins = (data as PluginMetadata[] | undefined) ?? [];
      return plugins.map(p => new PluginNode(p));
    } catch {
      return [];
    }
  }

  private async fetchRecordTypes(node: PluginNode): Promise<RecordTypeNode[]> {
    try {
      const { data } = await this.client.GET('/plugins/{plugin}/record-types', {
        params: { path: { plugin: node.plugin.name } },
      });
      const types = (data as { type: string; count: number }[] | undefined) ?? [];
      return types.map(t => new RecordTypeNode(node.plugin.name, t.type, t.count));
    } catch {
      return [];
    }
  }

  private async fetchRecords(node: RecordTypeNode): Promise<(RecordNode | LoadMoreNode)[]> {
    let cached = this.pageCache.get(node);
    if (!cached) {
      try {
        const { data } = await this.client.GET('/records', {
          params: {
            query: {
              plugin: node.plugin,
              type: node.recordType,
              limit: PAGE_SIZE,
              offset: 0,
            },
          },
        });
        const result = data as { items: RecordSummary[]; total: number } | undefined;
        cached = result ?? { items: [], total: 0 };
        this.pageCache.set(node, cached);
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

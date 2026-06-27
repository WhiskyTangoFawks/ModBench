import * as vscode from 'vscode';
import type {
  PluginMetadata, RecordSummary,
  WorldspaceSummary, CellSummary, PlacedSummary, WorldspaceBlock, WorldspaceSubBlock, CellReferences,
} from './ApiClient';
import type { PluginRepository } from './PluginRepository';

const PAGE_SIZE = 50;

// Record types represented spatially in the worldspace tree — hidden from the flat type list.
const SPATIAL_TYPES = new Set(['worldspace', 'cell', 'refr', 'achr']);

function formId(formKey: string): string {
  return formKey.split(':')[0];
}

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
    this.command = { command: 'mEdit.loadMore', title: 'Load More', arguments: [this] };
  }
}

// ── Phase 16: worldspace / cell / placed-object nodes ─────────────────────────

export class WorldspacesNode extends vscode.TreeItem {
  readonly kind = 'worldspaces' as const;
  constructor(public readonly plugin: string) {
    super('Worldspaces', vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'worldspaces';
    this.iconPath = new vscode.ThemeIcon('globe');
  }
}

export class WorldspaceNode extends vscode.TreeItem {
  readonly kind = 'worldspace' as const;
  constructor(public readonly plugin: string, public readonly worldspace: WorldspaceSummary) {
    const label = worldspace.editorId ?? worldspace.formKey;
    super(`${label} [WRLD:${formId(worldspace.formKey)}]`, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'worldspace';
    this.command = { command: 'mEdit.openEditor', title: 'Open Record', arguments: [{ formKey: worldspace.formKey, label }] };
  }
}

export class BlockNode extends vscode.TreeItem {
  readonly kind = 'block' as const;
  constructor(public readonly plugin: string, public readonly block: WorldspaceBlock) {
    super(`Block (${block.x}, ${block.y})`, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'block';
  }
}

export class SubBlockNode extends vscode.TreeItem {
  readonly kind = 'subBlock' as const;
  constructor(public readonly plugin: string, public readonly subBlock: WorldspaceSubBlock) {
    super(`Sub-block (${subBlock.x}, ${subBlock.y})`, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'subBlock';
  }
}

export class CellNode extends vscode.TreeItem {
  readonly kind = 'cell' as const;
  constructor(public readonly plugin: string, public readonly cell: CellSummary) {
    const label = cell.editorId
      ?? (cell.cellX != null ? `Cell (${cell.cellX}, ${cell.cellY})` : cell.formKey);
    super(label, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'cell';
    this.command = { command: 'mEdit.openEditor', title: 'Open Record', arguments: [{ formKey: cell.formKey, label }] };
  }
}

export class PlacedGroupNode extends vscode.TreeItem {
  readonly kind = 'placedGroup' as const;
  constructor(
    public readonly plugin: string,
    public readonly cellFormKey: string,
    public readonly group: 'persistent' | 'temporary',
    public readonly placed: PlacedSummary[],
  ) {
    super(group === 'persistent' ? 'Persistent' : 'Temporary', vscode.TreeItemCollapsibleState.Collapsed);
    this.description = placed.length.toLocaleString();
    this.contextValue = `placedGroup-${group}`;
  }
}

export class PlacedNode extends vscode.TreeItem {
  readonly kind = 'placed' as const;
  constructor(public readonly plugin: string, public readonly placed: PlacedSummary) {
    const name = placed.editorId ?? placed.baseFormKey ?? placed.formKey;
    const label = `${name} [${placed.recordType.toUpperCase()}:${formId(placed.formKey)}]`;
    super(label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'refr';
    this.command = { command: 'mEdit.openEditor', title: 'Open Record', arguments: [{ formKey: placed.formKey, label }] };
  }
}

export class InteriorCellsNode extends vscode.TreeItem {
  readonly kind = 'interiorCells' as const;
  constructor(public readonly plugin: string) {
    super('Interior Cells', vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'interiorCells';
    this.iconPath = new vscode.ThemeIcon('home');
  }
}

export class InteriorLoadMoreNode extends vscode.TreeItem {
  readonly kind = 'interiorLoadMore' as const;
  constructor(public readonly parentNode: InteriorCellsNode, remaining: number) {
    super(`$(sync) Load more… (${remaining.toLocaleString()} remaining)`, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'loadMore';
    this.command = { command: 'mEdit.loadMore', title: 'Load More', arguments: [this] };
  }
}

export type PluginTreeNode =
  | PluginNode | RecordTypeNode | RecordNode | LoadMoreNode
  | WorldspacesNode | WorldspaceNode | BlockNode | SubBlockNode | CellNode
  | PlacedGroupNode | PlacedNode | InteriorCellsNode | InteriorLoadMoreNode;

type PageCache = Map<string, { items: RecordSummary[]; total: number }>;
type CellPageCache = Map<string, { items: CellSummary[]; total: number }>;

export class PluginTreeProvider implements vscode.TreeDataProvider<PluginTreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<PluginTreeNode | undefined | null>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly pageCache: PageCache = new Map();
  private readonly interiorCache: CellPageCache = new Map();
  private readonly refCache = new Map<string, CellReferences>();
  private readonly log: (msg: string) => void;

  constructor(private readonly repository: PluginRepository, log?: (msg: string) => void) {
    this.log = log ?? (() => {});
  }

  refresh(): void {
    this.pageCache.clear();
    this.interiorCache.clear();
    this.refCache.clear();
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: PluginTreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: PluginTreeNode): Promise<PluginTreeNode[]> {
    if (!element) return this.fetchPlugins();
    if (element instanceof PluginNode) return this.fetchPluginChildren(element);
    if (element instanceof WorldspacesNode) return this.fetchWorldspaces(element);
    if (element instanceof WorldspaceNode) return this.fetchWorldspaceChildren(element);
    if (element instanceof BlockNode) return element.block.subBlocks.map(s => new SubBlockNode(element.plugin, s));
    if (element instanceof SubBlockNode) return element.subBlock.cells.map(c => new CellNode(element.plugin, c));
    if (element instanceof CellNode) return this.fetchCellGroups(element);
    if (element instanceof PlacedGroupNode) return element.placed.map(p => new PlacedNode(element.plugin, p));
    if (element instanceof InteriorCellsNode) return this.fetchInteriorCells(element);
    if (element instanceof RecordTypeNode) return this.fetchRecords(element);
    return [];
  }

  async loadMore(node: LoadMoreNode | InteriorLoadMoreNode): Promise<void> {
    if (node instanceof InteriorLoadMoreNode) return this.loadMoreInterior(node);

    const parent = node.parentNode;
    const cacheKey = this.cacheKey(parent);
    const cached = this.pageCache.get(cacheKey) ?? { items: [], total: 0 };
    try {
      const result = await this.repository.getRecords(parent.plugin, parent.recordType, cached.items.length, PAGE_SIZE);
      this.pageCache.set(cacheKey, { items: [...cached.items, ...result.items], total: result.total });
    } catch (e) {
      this.log(`[PluginTreeProvider] loadMore(${parent.plugin}, ${parent.recordType}) failed: ${this.err(e)}`);
    }
    this._onDidChangeTreeData.fire(parent);
  }

  private async loadMoreInterior(node: InteriorLoadMoreNode): Promise<void> {
    const parent = node.parentNode;
    const cached = this.interiorCache.get(parent.plugin) ?? { items: [], total: 0 };
    try {
      const result = await this.repository.getInteriorCells(parent.plugin, cached.items.length, PAGE_SIZE);
      this.interiorCache.set(parent.plugin, { items: [...cached.items, ...result.items], total: result.total });
    } catch (e) {
      this.log(`[PluginTreeProvider] loadMoreInterior(${parent.plugin}) failed: ${this.err(e)}`);
    }
    this._onDidChangeTreeData.fire(parent);
  }

  private cacheKey(node: RecordTypeNode): string {
    return `${node.plugin}::${node.recordType}`;
  }

  private err(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }

  private async fetchPlugins(): Promise<PluginNode[]> {
    try {
      const plugins = await this.repository.getPlugins();
      return plugins.map(p => new PluginNode(p));
    } catch (e) {
      this.log(`[PluginTreeProvider] fetchPlugins failed: ${this.err(e)}`);
      return [];
    }
  }

  private async fetchPluginChildren(node: PluginNode): Promise<PluginTreeNode[]> {
    try {
      const types = await this.repository.getRecordTypes(node.plugin.name);
      const nodes: PluginTreeNode[] = [];
      if (types.some(t => t.type === 'worldspace')) nodes.push(new WorldspacesNode(node.plugin.name));
      if (types.some(t => t.type === 'cell')) nodes.push(new InteriorCellsNode(node.plugin.name));
      for (const t of types) {
        if (!SPATIAL_TYPES.has(t.type)) nodes.push(new RecordTypeNode(node.plugin.name, t.type, t.count));
      }
      return nodes;
    } catch (e) {
      this.log(`[PluginTreeProvider] fetchPluginChildren(${node.plugin.name}) failed: ${this.err(e)}`);
      return [];
    }
  }

  private async fetchWorldspaces(node: WorldspacesNode): Promise<WorldspaceNode[]> {
    try {
      const worldspaces = await this.repository.getWorldspaces(node.plugin);
      return worldspaces.map(w => new WorldspaceNode(node.plugin, w));
    } catch (e) {
      this.log(`[PluginTreeProvider] fetchWorldspaces(${node.plugin}) failed: ${this.err(e)}`);
      return [];
    }
  }

  private async fetchWorldspaceChildren(node: WorldspaceNode): Promise<PluginTreeNode[]> {
    try {
      const data = await this.repository.getWorldspaceBlocks(node.plugin, node.worldspace.formKey);
      const nodes: PluginTreeNode[] = [];
      if (data.topCell) nodes.push(new CellNode(node.plugin, data.topCell));
      nodes.push(...data.blocks.map(b => new BlockNode(node.plugin, b)));
      return nodes;
    } catch (e) {
      this.log(`[PluginTreeProvider] fetchWorldspaceChildren(${node.worldspace.formKey}) failed: ${this.err(e)}`);
      return [];
    }
  }

  private async fetchCellGroups(node: CellNode): Promise<PlacedGroupNode[]> {
    const cacheKey = `${node.plugin}::${node.cell.formKey}`;
    let refs = this.refCache.get(cacheKey);
    if (!refs) {
      try {
        refs = await this.repository.getCellReferences(node.plugin, node.cell.formKey);
        this.refCache.set(cacheKey, refs);
      } catch (e) {
        this.log(`[PluginTreeProvider] fetchCellGroups(${node.cell.formKey}) failed: ${this.err(e)}`);
        return [];
      }
    }
    const groups: PlacedGroupNode[] = [];
    if (refs.persistent.length) groups.push(new PlacedGroupNode(node.plugin, node.cell.formKey, 'persistent', refs.persistent));
    if (refs.temporary.length) groups.push(new PlacedGroupNode(node.plugin, node.cell.formKey, 'temporary', refs.temporary));
    return groups;
  }

  private async fetchInteriorCells(node: InteriorCellsNode): Promise<PluginTreeNode[]> {
    let cached = this.interiorCache.get(node.plugin);
    if (!cached) {
      try {
        cached = await this.repository.getInteriorCells(node.plugin, 0, PAGE_SIZE);
        this.interiorCache.set(node.plugin, cached);
      } catch (e) {
        this.log(`[PluginTreeProvider] fetchInteriorCells(${node.plugin}) failed: ${this.err(e)}`);
        return [];
      }
    }
    const nodes: PluginTreeNode[] = cached.items.map(c => new CellNode(node.plugin, c));
    if (cached.total > cached.items.length) {
      nodes.push(new InteriorLoadMoreNode(node, cached.total - cached.items.length));
    }
    return nodes;
  }

  private async fetchRecords(node: RecordTypeNode): Promise<(RecordNode | LoadMoreNode)[]> {
    const cacheKey = this.cacheKey(node);
    let cached = this.pageCache.get(cacheKey);
    if (!cached) {
      try {
        cached = await this.repository.getRecords(node.plugin, node.recordType, 0, PAGE_SIZE);
        this.pageCache.set(cacheKey, cached);
      } catch (e) {
        this.log(`[PluginTreeProvider] fetchRecords(${node.plugin}, ${node.recordType}) failed: ${this.err(e)}`);
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

import * as vscode from 'vscode';
import type {
  RecordSummary,
  WorldspaceSummary, CellSummary, PlacedSummary, WorldspaceBlock, WorldspaceSubBlock, CellReferences,
} from './ApiClient';
import type { PluginRepository } from './PluginRepository';

const PAGE_SIZE = 50;

function formId(formKey: string): string {
  return formKey.split(':')[0];
}

/** Issue #1 slice A1: the synthetic FormKey a plugin's header record is indexed at. */
export function headerFormKeyFor(pluginName: string): string {
  return `000000:${pluginName}`;
}

// #273: this provider's own standalone plugin-row node (PluginNode, contextValue "plugin" /
// "pluginImmutable") is deleted — it was only ever constructed by fetchPlugins(), the root
// listing for the standalone editing Plugins tree (modbench.pluginTree) that this ticket retired.
// The merged tree's plugin rows are modmanager/PluginListProvider's PluginNode/ImplicitMasterNode
// instead (contextValue "plugin" / "pluginImplicit" — see plugins.md). Do not reintroduce a
// plugin-row node here: reconciling "pluginImmutable" with modmanager's read-only-ness story is
// #276's question, not answered by resurrecting this class.

export class RecordTypeNode extends vscode.TreeItem {
  readonly kind = 'recordType' as const;
  constructor(
    public readonly plugin: string,
    public readonly recordType: string,
    count: number,
    displayName: string = recordType,
    /** #34 / ADR-0036: which copy of `plugin` this node browses, or undefined for an ordinary
     *  load-order plugin (the backend resolves that case; a filename is unambiguous there). */
    public readonly origin?: string,
  ) {
    // Issue #110: label is the xEdit-parity display name ("Activator"); recordType (the raw
    // 4-char signature, e.g. "acti") stays the internal id — cache key, contextValue, commands.
    super(displayName, vscode.TreeItemCollapsibleState.Collapsed);
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
      command: 'modbench.openEditor',
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
    this.command = { command: 'modbench.loadMore', title: 'Load More', arguments: [this] };
  }
}

// ── Phase 16: worldspace / cell / placed-object nodes ─────────────────────────

// #305 / ADR-0036: every node in the spatial chain carries the same optional `origin` RecordTypeNode
// already does — a node built for a specific copy has to keep saying so all the way down to its
// leaves, since each hop's own repository call needs it too.
export class WorldspacesNode extends vscode.TreeItem {
  readonly kind = 'worldspaces' as const;
  constructor(public readonly plugin: string, public readonly origin?: string) {
    super('Worldspaces', vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'worldspaces';
    this.iconPath = new vscode.ThemeIcon('globe');
  }
}

export class WorldspaceNode extends vscode.TreeItem {
  readonly kind = 'worldspace' as const;
  constructor(public readonly plugin: string, public readonly worldspace: WorldspaceSummary, public readonly origin?: string) {
    const label = worldspace.editorId ?? worldspace.formKey;
    super(`${label} [WRLD:${formId(worldspace.formKey)}]`, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'worldspace';
    this.command = { command: 'modbench.openEditor', title: 'Open Record', arguments: [{ formKey: worldspace.formKey, label }] };
  }
}

export class BlockNode extends vscode.TreeItem {
  readonly kind = 'block' as const;
  constructor(public readonly plugin: string, public readonly block: WorldspaceBlock, public readonly origin?: string) {
    super(`Block (${block.x}, ${block.y})`, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'block';
  }
}

export class SubBlockNode extends vscode.TreeItem {
  readonly kind = 'subBlock' as const;
  constructor(public readonly plugin: string, public readonly subBlock: WorldspaceSubBlock, public readonly origin?: string) {
    super(`Sub-block (${subBlock.x}, ${subBlock.y})`, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'subBlock';
  }
}

export class CellNode extends vscode.TreeItem {
  readonly kind = 'cell' as const;
  constructor(public readonly plugin: string, public readonly cell: CellSummary, public readonly origin?: string) {
    const label = cell.editorId
      ?? (cell.cellX != null ? `Cell (${cell.cellX}, ${cell.cellY})` : cell.formKey);
    super(label, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'cell';
    this.command = { command: 'modbench.openEditor', title: 'Open Record', arguments: [{ formKey: cell.formKey, label }] };
  }
}

export class PlacedGroupNode extends vscode.TreeItem {
  readonly kind = 'placedGroup' as const;
  constructor(
    public readonly plugin: string,
    public readonly cellFormKey: string,
    public readonly group: 'persistent' | 'temporary',
    public readonly placed: PlacedSummary[],
    public readonly origin?: string,
  ) {
    super(group === 'persistent' ? 'Persistent' : 'Temporary', vscode.TreeItemCollapsibleState.Collapsed);
    this.description = placed.length.toLocaleString();
    this.contextValue = `placedGroup-${group}`;
  }
}

export class PlacedNode extends vscode.TreeItem {
  readonly kind = 'placed' as const;
  constructor(public readonly plugin: string, public readonly placed: PlacedSummary, public readonly origin?: string) {
    const name = placed.editorId ?? placed.baseFormKey ?? placed.formKey;
    const label = `${name} [${placed.recordType.toUpperCase()}:${formId(placed.formKey)}]`;
    super(label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'refr';
    this.command = { command: 'modbench.openEditor', title: 'Open Record', arguments: [{ formKey: placed.formKey, label }] };
  }
}

export class InteriorCellsNode extends vscode.TreeItem {
  readonly kind = 'interiorCells' as const;
  constructor(public readonly plugin: string, public readonly origin?: string) {
    super('cell - Interior', vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'interiorCells';
  }
}

export class InteriorLoadMoreNode extends vscode.TreeItem {
  readonly kind = 'interiorLoadMore' as const;
  constructor(public readonly parentNode: InteriorCellsNode, remaining: number) {
    super(`$(sync) Load more… (${remaining.toLocaleString()} remaining)`, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'loadMore';
    this.command = { command: 'modbench.loadMore', title: 'Load More', arguments: [this] };
  }
}

/** Inline error surface: shown instead of an empty list when a fetch fails,
 *  so a failure is never indistinguishable from "nothing here" (ADR-0026). */
export class ErrorNode extends vscode.TreeItem {
  readonly kind = 'error' as const;
  constructor(message: string) {
    super(`⚠ Failed to load: ${message}`, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'error';
    this.tooltip = message;
    this.iconPath = new vscode.ThemeIcon('error');
  }
}

export type PluginTreeNode =
  | RecordTypeNode | RecordNode | LoadMoreNode
  | WorldspacesNode | WorldspaceNode | BlockNode | SubBlockNode | CellNode
  | PlacedGroupNode | PlacedNode | InteriorCellsNode | InteriorLoadMoreNode | ErrorNode;

// Record types that get their own dedicated node in the worldspace tree, keyed by raw
// signature — the single source of truth for which spatial type maps to which node
// (issue #197: previously a set membership check and a separate equality check per type,
// which could drift out of sync the way #173 did).
const SPATIAL_NODE_FACTORIES: Record<string, (pluginName: string, origin?: string) => PluginTreeNode> = {
  wrld: (pluginName, origin) => new WorldspacesNode(pluginName, origin),
  cell: (pluginName, origin) => new InteriorCellsNode(pluginName, origin),
};

// Record types represented spatially in the worldspace tree — hidden from the flat type
// list. refr/achr nest under the cell hierarchy (fetchCellGroups) rather than getting a
// top-level node of their own, so they're not in SPATIAL_NODE_FACTORIES.
const SPATIAL_TYPES = new Set([...Object.keys(SPATIAL_NODE_FACTORIES), 'refr', 'achr']);

type PageCache = Map<string, { items: RecordSummary[]; total: number }>;
type CellPageCache = Map<string, { items: CellSummary[]; total: number }>;

export class PluginTreeProvider implements vscode.TreeDataProvider<PluginTreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<PluginTreeNode | undefined | null>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly pageCache: PageCache = new Map();
  private readonly interiorCache: CellPageCache = new Map();
  private readonly refCache = new Map<string, CellReferences>();
  // Last load-more failure per parent, keyed the same as pageCache/interiorCache
  // (originKey + "::recordType" / originKey alone). Cleared on a successful retry; renders as an
  // ErrorNode alongside the still-clickable LoadMoreNode/InteriorLoadMoreNode.
  private readonly loadMoreFailures = new Map<string, string>();
  private readonly interiorLoadMoreFailures = new Map<string, string>();
  private readonly log: (msg: string) => void;

  constructor(private readonly repository: PluginRepository, log?: (msg: string) => void) {
    this.log = log ?? (() => {});
  }

  refresh(): void {
    this.pageCache.clear();
    this.interiorCache.clear();
    this.refCache.clear();
    this.loadMoreFailures.clear();
    this.interiorLoadMoreFailures.clear();
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: PluginTreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: PluginTreeNode): Promise<PluginTreeNode[]> {
    // #273: `element` is never actually undefined here — PluginsTreeComposite's own
    // `children` contract (PluginsTreeCompositeDeps) declares getChildren(child: TChild) as
    // required, and calls this only with a defined element (root rows come from
    // PluginListProvider instead) or via getPluginChildren(file) directly. The `!element`
    // case stays only to satisfy vscode.TreeDataProvider<T>'s own optional-parameter contract.
    if (!element) return [];
    if (element instanceof RecordTypeNode) return this.fetchRecords(element);
    return this.getSpatialChildren(element);
  }

  // Dispatch for the worldspace / cell / block spatial hierarchy, split out of getChildren
  // so neither dispatch ladder exceeds the complexity budget.
  private getSpatialChildren(element: PluginTreeNode): Promise<PluginTreeNode[]> | PluginTreeNode[] {
    if (element instanceof WorldspacesNode) return this.fetchWorldspaces(element);
    if (element instanceof WorldspaceNode) return this.fetchWorldspaceChildren(element);
    if (element instanceof BlockNode) return element.block.subBlocks.map(s => new SubBlockNode(element.plugin, s, element.origin));
    if (element instanceof SubBlockNode) return element.subBlock.cells.map(c => new CellNode(element.plugin, c, element.origin));
    if (element instanceof CellNode) return this.fetchCellGroups(element);
    if (element instanceof PlacedGroupNode) return element.placed.map(p => new PlacedNode(element.plugin, p, element.origin));
    if (element instanceof InteriorCellsNode) return this.fetchInteriorCells(element);
    return [];
  }

  async loadMore(node: LoadMoreNode | InteriorLoadMoreNode): Promise<void> {
    if (node instanceof InteriorLoadMoreNode) return this.loadMoreInterior(node);

    const parent = node.parentNode;
    const cacheKey = this.cacheKey(parent);
    const cached = this.pageCache.get(cacheKey) ?? { items: [], total: 0 };
    try {
      const result = await this.repository.getRecords(parent.plugin, parent.recordType, cached.items.length, PAGE_SIZE, parent.origin);
      this.pageCache.set(cacheKey, { items: [...cached.items, ...result.items], total: result.total });
      this.loadMoreFailures.delete(cacheKey);
    } catch (e) {
      const message = this.err(e);
      this.log(`[PluginTreeProvider] loadMore(${parent.plugin}, ${parent.recordType}) failed: ${message}`);
      this.loadMoreFailures.set(cacheKey, message);
    }
    this._onDidChangeTreeData.fire(parent);
  }

  private async loadMoreInterior(node: InteriorLoadMoreNode): Promise<void> {
    const parent = node.parentNode;
    const cacheKey = this.originKey(parent.plugin, parent.origin);
    const cached = this.interiorCache.get(cacheKey) ?? { items: [], total: 0 };
    try {
      const result = await this.repository.getInteriorCells(parent.plugin, cached.items.length, PAGE_SIZE, parent.origin);
      this.interiorCache.set(cacheKey, { items: [...cached.items, ...result.items], total: result.total });
      this.interiorLoadMoreFailures.delete(cacheKey);
    } catch (e) {
      const message = this.err(e);
      this.log(`[PluginTreeProvider] loadMoreInterior(${parent.plugin}) failed: ${message}`);
      this.interiorLoadMoreFailures.set(cacheKey, message);
    }
    this._onDidChangeTreeData.fire(parent);
  }

  // #34 / #305: the origin is part of every spatial/record cache key, not decoration — two copies
  // of one filename have their own pages, and serving one copy's page (or interior-cell page, or
  // cell's placed refs) under the other's node is the exact "right target, wrong content" failure
  // #34 exists to remove and #305 extends to the rest of the spatial tree. Undefined origin keeps
  // the pre-#34 key shape, so every existing load-order entry is untouched.
  private originKey(plugin: string, origin?: string): string {
    return `${plugin}|${origin ?? ''}`;
  }

  private cacheKey(node: RecordTypeNode): string {
    return `${this.originKey(node.plugin, node.origin)}::${node.recordType}`;
  }

  private err(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }

  /** A plugin's children — its spatial group nodes and flat record-type nodes — keyed by filename
   *  rather than by a node this provider built. Public because the merged Plugins tree (#270 /
   *  ADR-0035) is the only caller: `PluginsTreeComposite` expands rows built by
   *  `PluginListProvider`, and its whole knowledge of this side is a plugin filename. #273
   *  deleted this provider's own standalone root listing (`fetchPlugins`/`PluginNode`) once the
   *  standalone editing Plugins tree that was its only caller was retired — this is now the one
   *  way into a plugin's children. */
  async getPluginChildren(pluginName: string, origin?: string): Promise<PluginTreeNode[]> {
    try {
      const types = await this.repository.getRecordTypes(pluginName, origin);
      const typesPresent = new Set(types.map(t => t.type));
      const nodes: PluginTreeNode[] = [];
      // #305: the spatial endpoints now take the same optional origin the flat record routes do
      // (RecordTypeNode below), so a copy the load order does not name browses its own worldspaces
      // and cells instead of having them omitted entirely.
      for (const [type, makeNode] of Object.entries(SPATIAL_NODE_FACTORIES)) {
        if (typesPresent.has(type)) nodes.push(makeNode(pluginName, origin));
      }
      for (const t of types) {
        if (!SPATIAL_TYPES.has(t.type)) nodes.push(new RecordTypeNode(pluginName, t.type, t.count, t.displayName, origin));
      }
      return nodes;
    } catch (e) {
      const message = this.err(e);
      this.log(`[PluginTreeProvider] getPluginChildren(${pluginName}) failed: ${message}`);
      return [new ErrorNode(message)];
    }
  }

  private async fetchWorldspaces(node: WorldspacesNode): Promise<PluginTreeNode[]> {
    try {
      const worldspaces = await this.repository.getWorldspaces(node.plugin, node.origin);
      return worldspaces.map(w => new WorldspaceNode(node.plugin, w, node.origin));
    } catch (e) {
      const message = this.err(e);
      this.log(`[PluginTreeProvider] fetchWorldspaces(${node.plugin}) failed: ${message}`);
      return [new ErrorNode(message)];
    }
  }

  private async fetchWorldspaceChildren(node: WorldspaceNode): Promise<PluginTreeNode[]> {
    try {
      const data = await this.repository.getWorldspaceBlocks(node.plugin, node.worldspace.formKey, node.origin);
      const nodes: PluginTreeNode[] = [];
      if (data.topCell) nodes.push(new CellNode(node.plugin, data.topCell, node.origin));
      nodes.push(...data.blocks.map(b => new BlockNode(node.plugin, b, node.origin)));
      return nodes;
    } catch (e) {
      const message = this.err(e);
      this.log(`[PluginTreeProvider] fetchWorldspaceChildren(${node.worldspace.formKey}) failed: ${message}`);
      return [new ErrorNode(message)];
    }
  }

  private async fetchCellGroups(node: CellNode): Promise<PluginTreeNode[]> {
    const cacheKey = `${this.originKey(node.plugin, node.origin)}::${node.cell.formKey}`;
    let refs = this.refCache.get(cacheKey);
    if (!refs) {
      try {
        refs = await this.repository.getCellReferences(node.plugin, node.cell.formKey, node.origin);
        this.refCache.set(cacheKey, refs);
      } catch (e) {
        const message = this.err(e);
        this.log(`[PluginTreeProvider] fetchCellGroups(${node.cell.formKey}) failed: ${message}`);
        return [new ErrorNode(message)];
      }
    }
    const groups: PlacedGroupNode[] = [];
    if (refs.persistent.length) groups.push(new PlacedGroupNode(node.plugin, node.cell.formKey, 'persistent', refs.persistent, node.origin));
    if (refs.temporary.length) groups.push(new PlacedGroupNode(node.plugin, node.cell.formKey, 'temporary', refs.temporary, node.origin));
    return groups;
  }

  private async fetchInteriorCells(node: InteriorCellsNode): Promise<PluginTreeNode[]> {
    const cacheKey = this.originKey(node.plugin, node.origin);
    let cached = this.interiorCache.get(cacheKey);
    if (!cached) {
      try {
        cached = await this.repository.getInteriorCells(node.plugin, 0, PAGE_SIZE, node.origin);
        this.interiorCache.set(cacheKey, cached);
      } catch (e) {
        const message = this.err(e);
        this.log(`[PluginTreeProvider] fetchInteriorCells(${node.plugin}) failed: ${message}`);
        return [new ErrorNode(message)];
      }
    }
    const nodes: PluginTreeNode[] = cached.items.map(c => new CellNode(node.plugin, c, node.origin));
    if (cached.total > cached.items.length) {
      nodes.push(new InteriorLoadMoreNode(node, cached.total - cached.items.length));
    }
    const failure = this.interiorLoadMoreFailures.get(cacheKey);
    if (failure) nodes.push(new ErrorNode(failure));
    return nodes;
  }

  private async fetchRecords(node: RecordTypeNode): Promise<PluginTreeNode[]> {
    const cacheKey = this.cacheKey(node);
    let cached = this.pageCache.get(cacheKey);
    if (!cached) {
      try {
        cached = await this.repository.getRecords(node.plugin, node.recordType, 0, PAGE_SIZE, node.origin);
        this.pageCache.set(cacheKey, cached);
      } catch (e) {
        const message = this.err(e);
        this.log(`[PluginTreeProvider] fetchRecords(${node.plugin}, ${node.recordType}) failed: ${message}`);
        return [new ErrorNode(message)];
      }
    }

    const nodes: PluginTreeNode[] = cached.items.map(r => new RecordNode(r));
    if (cached.total > cached.items.length) {
      nodes.push(new LoadMoreNode(node, cached.total - cached.items.length));
    }
    const failure = this.loadMoreFailures.get(cacheKey);
    if (failure) nodes.push(new ErrorNode(failure));
    return nodes;
  }
}

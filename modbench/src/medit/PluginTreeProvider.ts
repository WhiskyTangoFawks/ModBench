import * as vscode from 'vscode';
import type {
  RecordSummary,
  WorldspaceSummary, CellSummary, PlacedSummary, WorldspaceBlock, WorldspaceSubBlock, CellReferences,
} from './ApiClient';
import type { PluginRepository } from './PluginRepository';
import { recordResourceUri } from './recordResourceUri';

// #398: interior-cell listing is the only surface left that pages — record-type children (below)
// load in one call now (measured no meaningful cost even at the realistic worst case; see
// fetchRecords and docs/specs/plugins.md).
const PAGE_SIZE = 50;

// The backend's `/records` `limit` query param is a plain `int`, no upper bound enforced —
// Int32.MaxValue as "no limit" fetches every record of a type in one call. #398.
const UNLIMITED_RECORDS = 2147483647;

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
  // #281: a record-scoped command acts on the clicked row's own copy of the record, so the row
  // carries which copy it is ((plugin via record, origin) — ADR-0036), and a row whose plugin
  // can't be edited hides Remove via its contextValue, matching the column header's !immutable
  // `when` gate.
  constructor(
    public readonly record: RecordSummary,
    public readonly origin?: string,
    immutable = false,
  ) {
    const label = record.editorId ? `${record.editorId} [${record.formKey}]` : record.formKey;
    super(label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = immutable ? 'recordImmutable' : 'record';
    this.command = {
      command: 'modbench.openEditor',
      title: 'Open Record',
      arguments: [{ formKey: record.formKey, label }],
    };
    // #428: RecordDecorationProvider's own keying identity — record.plugin (this row's own copy's
    // owning plugin, which an override stack row can differ from the RecordTypeNode's plugin) paired
    // with origin, the same (plugin, origin, formKey) triple every record-scoped command already uses.
    this.resourceUri = recordResourceUri(record.plugin, origin, record.formKey);
  }
}

// ── Worldspace / cell / placed-object nodes ─────────────────────────

// #305 / ADR-0036: every node in the spatial chain carries the same optional `origin` RecordTypeNode
// already does — a node built for a specific copy has to keep saying so all the way down to its
// leaves, since each hop's own repository call needs it too.
export class WorldspacesNode extends vscode.TreeItem {
  readonly kind = 'worldspaces' as const;
  constructor(public readonly plugin: string, public readonly origin?: string) {
    super('Worldspaces', vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'worldspaces';
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

// xEdit's TwbGroupRecord.GetShortName (wbImplementation.pas), group types 4/5: 'Block ' + Hi + ', '
// + Lo / 'Sub-Block ' + Hi + ', ' + Lo — no parens, capital B in "Sub-Block".
export class BlockNode extends vscode.TreeItem {
  readonly kind = 'block' as const;
  constructor(public readonly plugin: string, public readonly block: WorldspaceBlock, public readonly origin?: string) {
    super(`Block ${block.x}, ${block.y}`, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'block';
  }
}

export class SubBlockNode extends vscode.TreeItem {
  readonly kind = 'subBlock' as const;
  constructor(public readonly plugin: string, public readonly subBlock: WorldspaceSubBlock, public readonly origin?: string) {
    super(`Sub-Block ${subBlock.x}, ${subBlock.y}`, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'subBlock';
  }
}

// xEdit's StrRight (wbImplementation.pas) right-justifies each grid coordinate to width 3 with
// leading spaces before wrapping it in the angle brackets — not a plain decimal string.
function strRight3(n: number | null): string {
  return String(n).padStart(3, ' ');
}

export class CellNode extends vscode.TreeItem {
  readonly kind = 'cell' as const;
  constructor(public readonly plugin: string, public readonly cell: CellSummary, public readonly origin?: string) {
    // xEdit's TwbMainRecord.GetDisplayName CELL branch (wbImplementation.pas), read directly (#497
    // — #251's original version of this comment paraphrased the precedence and got it wrong; do
    // not re-derive it from this comment either, go back to the source if it's ever in doubt):
    //
    //   Result := GetFullName;
    //   if Result = '' then
    //     if ... else if (GetSignature = 'CELL') then begin
    //       if Supports(GetContainer, IwbGroupRecord, GroupRecord) and (GroupRecord.GroupType = 1) then
    //         Result := '<Persistent Worldspace Cell>'
    //       else
    //         if GetGridCell(GridCell) then
    //           Result := '<' + StrRight(GridCell.X.ToString, 3) + ', ' + StrRight(GridCell.Y.ToString, 3) + '>';
    //     end else if ...
    //
    // GetFullName runs unconditionally, before any signature-specific branch — including CELL's
    // own persistent-cell (group type 1) check. So FULL name wins even for the worldspace's own
    // persistent cell; the placeholder and the grid format are both only reached when FULL is
    // empty. EditorID is never referenced anywhere in this function, for any signature — an
    // interior cell (no grid coordinates, out of scope for #251) keeps the EditorID-or-FormKey
    // fallback below, but that is this file's own choice for the case xEdit's GetDisplayName
    // resolves through its generic GetSummary fallback instead, not xEdit's own precedence.
    const label = cell.fullName
      ? cell.fullName
      : cell.isPersistentWorldspaceCell
        ? '<Persistent Worldspace Cell>'
        : cell.cellX != null
          ? `<${strRight3(cell.cellX)}, ${strRight3(cell.cellY)}>`
          : cell.editorId ?? cell.formKey;
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
  // #281: same copy-identity/immutability rule as RecordNode above.
  constructor(
    public readonly plugin: string,
    public readonly placed: PlacedSummary,
    public readonly origin?: string,
    immutable = false,
  ) {
    const name = placed.editorId ?? placed.baseFormKey ?? placed.formKey;
    const label = `${name} [${placed.recordType.toUpperCase()}:${formId(placed.formKey)}]`;
    super(label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = immutable ? 'refrImmutable' : 'refr';
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
  | RecordTypeNode | RecordNode
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
  // Last load-more failure per parent, keyed by originKey alone — interior cells are the only
  // surface left that pages (#398 removed record-type pagination). Cleared on a successful retry;
  // renders as an ErrorNode alongside the still-clickable InteriorLoadMoreNode.
  private readonly interiorLoadMoreFailures = new Map<string, string>();
  // #281: lowercased filenames of the session's immutable plugins (the same set extension.ts
  // already hands PluginsTreeComposite.setSession as readOnlyFiles) — record/placed rows under
  // one hide Remove via their contextValue, matching the column header's !immutable `when` gate.
  private readonly immutablePlugins = new Set<string>();
  private readonly log: (msg: string) => void;

  constructor(private readonly repository: PluginRepository, log?: (msg: string) => void) {
    this.log = log ?? (() => {});
  }

  setImmutablePlugins(names: Iterable<string>): void {
    this.immutablePlugins.clear();
    for (const n of names) this.immutablePlugins.add(n.toLowerCase());
    this._onDidChangeTreeData.fire(undefined);
  }

  // #281 / ADR-0036: a shadowed copy (origin stated) is read-only by construction — an edit to a
  // file the game does not load changes nothing observable — so origin alone decides before the
  // immutable set is even consulted.
  private isImmutable(plugin: string, origin?: string): boolean {
    return origin !== undefined || this.immutablePlugins.has(plugin.toLowerCase());
  }

  refresh(): void {
    this.pageCache.clear();
    this.interiorCache.clear();
    this.refCache.clear();
    this.interiorLoadMoreFailures.clear();
    this._onDidChangeTreeData.fire(undefined);
  }

  // #428 Q1 (orchestrator gate ruling): a field edit is this product's hottest path, so it gets a
  // scoped fix rather than refresh()'s wholesale cache-clear-and-refetch — a page cache entry a
  // field edit's own record already lives in is patched in place, never invalidated, so nothing
  // this method (or markWorkingTreeState below, which shares this scan) ever triggers a
  // repository call. Restricted to cache entries under this (plugin, origin) — the same prefix
  // fetchRecords' own cacheKey uses — never a full-cache scan.
  private findCachedRecordLocation(
    plugin: string, origin: string | undefined, formKey: string,
  ): { key: string; index: number } | undefined {
    const prefix = `${this.originKey(plugin, origin)}::`;
    for (const [key, page] of this.pageCache) {
      if (!key.startsWith(prefix)) continue;
      const index = page.items.findIndex(r => r.formKey === formKey);
      if (index !== -1) return { key, index };
    }
    return undefined;
  }

  /** The record's own cached working-tree state — what {@link RecordDecorationProvider}'s lookup
   *  callback reads. Undefined when nothing has cached this record yet (never rendered, or a
   *  since-cleared cache), which the provider reads the same as 'None': nothing to badge. */
  workingTreeStateOf(plugin: string, origin: string | undefined, formKey: string): RecordSummary['workingTreeState'] | undefined {
    const loc = this.findCachedRecordLocation(plugin, origin, formKey);
    return loc && this.pageCache.get(loc.key)!.items[loc.index].workingTreeState;
  }

  /** #428 Q1: patches exactly one cached record's working-tree state — called from the edit-field
   *  wiring (`onRecordEdited`) instead of `refresh()`. Returns whether a cached row existed to
   *  patch, so the caller knows whether there is anything for a decoration refresh to reflect (a
   *  record nothing has rendered yet needs neither). Fires `onDidChangeTreeData(undefined)` only
   *  on an actual change — cheap here specifically because the cache is never cleared, so any
   *  redraw it causes reads back the same (now-correct) data with no repository call.
   *
   *  Never downgrades Added to Modified (#428 review finding 1): a create never seeds a committed
   *  counterpart no matter how many field edits follow it (`CreateWorkingTreeRecord`'s own doc
   *  comment — nothing in `records_committed` for a FormKey that never existed at Head), so the
   *  backend's own discrimination would still answer Added on the next real fetch. Overwriting it
   *  here would actively misrepresent a committed counterpart existing, not just go briefly stale
   *  — worse than the staleness this method otherwise accepts. */
  markWorkingTreeState(
    plugin: string, origin: string | undefined, formKey: string, state: RecordSummary['workingTreeState'],
  ): boolean {
    const loc = this.findCachedRecordLocation(plugin, origin, formKey);
    if (!loc) return false;
    const page = this.pageCache.get(loc.key)!;
    const current = page.items[loc.index].workingTreeState;
    if (current === state || current === 'Added') return true;
    const items = [...page.items];
    items[loc.index] = { ...items[loc.index], workingTreeState: state };
    this.pageCache.set(loc.key, { ...page, items });
    this._onDidChangeTreeData.fire(undefined);
    return true;
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
    if (element instanceof PlacedGroupNode) {
      return element.placed.map(p =>
        new PlacedNode(element.plugin, p, element.origin, this.isImmutable(element.plugin, element.origin)));
    }
    if (element instanceof InteriorCellsNode) return this.fetchInteriorCells(element);
    return [];
  }

  // #398: the only pagination left in this provider — record-type children load in one
  // getChildren call now (see fetchRecords).
  async loadMore(node: InteriorLoadMoreNode): Promise<void> {
    const parent = node.parentNode;
    const cacheKey = this.originKey(parent.plugin, parent.origin);
    const cached = this.interiorCache.get(cacheKey) ?? { items: [], total: 0 };
    try {
      const result = await this.repository.getInteriorCells(parent.plugin, cached.items.length, PAGE_SIZE, parent.origin);
      this.interiorCache.set(cacheKey, { items: [...cached.items, ...result.items], total: result.total });
      this.interiorLoadMoreFailures.delete(cacheKey);
    } catch (e) {
      const message = this.err(e);
      this.log(`[PluginTreeProvider] loadMore(${parent.plugin}) failed: ${message}`);
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
      const nodes: PluginTreeNode[] = data.topCells.map(c => new CellNode(node.plugin, c, node.origin));
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
        // #398: every record of this type, one call, no "Load more…" step — measured no
        // meaningful cost even at the realistic worst case (Fallout4.esm's own INFO records in a
        // full FO4 load order, ~78k rows, ~500ms backend query + extension-host materialization
        // combined; docs/specs/plugins.md). Matches xEdit's own record-type group nodes, which
        // load unconditionally in full (xeMainForm.pas `vstNavInitChildren`:
        // `ChildCount := Container.ElementCount`, no LIMIT).
        cached = await this.repository.getRecords(node.plugin, node.recordType, 0, UNLIMITED_RECORDS, node.origin);
        this.pageCache.set(cacheKey, cached);
      } catch (e) {
        const message = this.err(e);
        this.log(`[PluginTreeProvider] fetchRecords(${node.plugin}, ${node.recordType}) failed: ${message}`);
        return [new ErrorNode(message)];
      }
    }

    return cached.items.map(r => new RecordNode(r, node.origin, this.isImmutable(r.plugin, node.origin)));
  }
}

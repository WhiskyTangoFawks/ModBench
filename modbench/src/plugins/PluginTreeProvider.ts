import * as vscode from 'vscode';
import { ErrorNode } from './errorNode';
import type {
  RecordSummary,
  WorldspaceSummary, CellSummary, PlacedSummary, WorldspaceBlock, WorldspaceSubBlock, CellReferences,
  ContainerChildSummary, MEditClient, PluginAddress,
} from '../client';
import { recordResourceUri } from './recordResourceUri';
import { failurePrefixIcon } from './failurePrefixIcon';
import { pluginAddressKey } from './trackedRepositories';
import { present } from '../ports/present';
import { errorMessage } from '../ports/errorMessage';
export { headerFormKeyFor } from './formKeyIdentity';

// Interior-cell listing is the only surface that pages — record-type children (below) load in
// one call (plugins.md, The tree, story 10). Measured, that costs nothing noticeable even at the
// realistic worst case (see fetchRecords).
const PAGE_SIZE = 50;

// The backend's `/records` `limit` query param is a plain `int`, no upper bound enforced —
// Int32.MaxValue as "no limit" fetches every record of a type in one call.
const UNLIMITED_RECORDS = 2147483647;

function formId(formKey: string): string {
  return present(formKey.split(':')[0], 'first segment of a formKey');
}

// "Could not be read into its document" rather than "Mutagen could not parse it": ingest's one
// catch spans the read, the reference walk and the codec write, and only the diagnosis knows which.
function failureNote(subject: string, diagnosis: string | null | undefined): string {
  return diagnosis
    ? `${subject} could not be read into its document: ${diagnosis}`
    : `${subject} holds a record that could not be read into its document.`;
}

// The backend says which nodes hold an unreadable record, so nothing here walks children.
function markFailure(item: vscode.TreeItem, tooltip: string): void {
  item.iconPath = failurePrefixIcon();
  item.tooltip = tooltip;
}

// This provider deliberately has no plugin-row node — the merged tree's plugin rows are
// PluginsTreeProvider's. Do not reintroduce one: reconciling a "pluginImmutable" contextValue
// with the row's own read-only-ness story is an open question.

export class RecordTypeNode extends vscode.TreeItem {
  readonly kind = 'recordType' as const;
  constructor(
    public readonly plugin: string,
    public readonly recordType: string,
    count: number,
    displayName: string = recordType,
    /** ADR-0012: which plugin named `plugin` this node browses, or undefined for an ordinary
     *  load-order plugin (the backend resolves that case; a filename is unambiguous there). */
    public readonly origin?: string,
    hasParseFailure = false,
  ) {
    // Label is the xEdit-parity display name ("Activator"); recordType (the raw
    // 4-char signature, e.g. "acti") stays the internal id — cache key, contextValue, commands.
    super(displayName, vscode.TreeItemCollapsibleState.Collapsed);
    this.description = count.toLocaleString();
    this.contextValue = 'recordType';
    if (hasParseFailure) markFailure(this, failureNote(displayName, null));
  }
}

// The contextValues state, on the row, refusals the backend would otherwise reach only after
// walking the whole gesture. FormKey shape is Mutagen's own "<hex6>:<ModKey>", so the defining
// plugin is everything after the first colon.
function recordContextValue(record: RecordSummary, immutable: boolean, tracked: boolean): string {
  if (immutable) return 'recordImmutable';
  // toLowerCase, not localeCompare: matches the backend's OrdinalIgnoreCase filename semantics
  // without host-locale hazards.
  const originModKey = record.formKey.slice(record.formKey.indexOf(':') + 1);
  if (originModKey.toLowerCase() !== record.plugin.toLowerCase()) return 'recordOverride';
  return tracked ? 'recordTracked' : 'recordUntracked';
}

export class RecordNode extends vscode.TreeItem {
  readonly kind = 'record' as const;
  // A record-scoped command acts on the clicked row's own copy of the record, so the row carries
  // which copy it is (plugin via record, origin — ADR-0012); a row whose plugin can't be edited
  // hides Remove.
  constructor(
    public readonly record: RecordSummary,
    public readonly origin?: string,
    immutable = false,
    // Whether this row's plugin is tracked, pushed in by `setTrackedPlugins` and never probed
    // from here. Defaults false because untracked is the state that withholds a gesture: a caller
    // that has not said gets the narrower row.
    tracked = false,
    // Set for a Quest or Dialog Topic — this same row type expands into their children rather
    // than forking a wrapper node the way WorldspacesNode/CellNode do, so a container's own row
    // stays a fully-affordanced record row.
    public readonly containerChildType?: 'qust' | 'dial',
    // A qust/dial row shows an expand chevron only when this is true — a Quest with zero
    // children is a leaf. From the same bulk listing `record` came from, never a per-row
    // follow-up call.
    public readonly hasContainerChildren = false,
  ) {
    const label = record.editorId ? `${record.editorId} [${record.formKey}]` : record.formKey;
    const collapsible = containerChildType && hasContainerChildren;
    super(label, collapsible ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    this.contextValue = recordContextValue(record, immutable, tracked);
    this.command = {
      command: 'modbench.openEditor',
      title: 'Open Record',
      arguments: [{ formKey: record.formKey, label }],
    };
    // RecordDecorationProvider's keying identity — record.plugin (this row's own copy's owning
    // plugin, which an override stack row can differ from the RecordTypeNode's) paired with origin.
    this.resourceUri = recordResourceUri(record.plugin, origin, record.formKey);
    if (record.hasParseFailure) markFailure(this, failureNote('This record', record.parseDiagnosis));
  }
}

// ── Worldspace / cell / placed-object nodes ─────────────────────────

// ADR-0012: every node in the spatial chain carries the same optional `origin` — a node built for
// a specific plugin has to keep saying so down to its leaves, since each hop's own repository call
// needs it too.
export class WorldspacesNode extends vscode.TreeItem {
  readonly kind = 'worldspaces' as const;
  constructor(public readonly plugin: string, public readonly origin?: string, hasParseFailure = false) {
    super('Worldspaces', vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'worldspaces';
    if (hasParseFailure) markFailure(this, failureNote('Worldspaces', null));
  }
}

export class WorldspaceNode extends vscode.TreeItem {
  readonly kind = 'worldspace' as const;
  constructor(public readonly plugin: string, public readonly worldspace: WorldspaceSummary, public readonly origin?: string) {
    const label = worldspace.editorId ?? worldspace.formKey;
    super(`${label} [WRLD:${formId(worldspace.formKey)}]`, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'worldspace';
    this.command = { command: 'modbench.openEditor', title: 'Open Record', arguments: [{ formKey: worldspace.formKey, label }] };
    if (worldspace.hasParseFailure) markFailure(this, failureNote(label, null));
  }
}

// xEdit's TwbGroupRecord.GetShortName (wbImplementation.pas), group types 4/5: 'Block ' + Hi + ', '
// + Lo / 'Sub-Block ' + Hi + ', ' + Lo — no parens, capital B in "Sub-Block".
export class BlockNode extends vscode.TreeItem {
  readonly kind = 'block' as const;
  constructor(public readonly plugin: string, public readonly block: WorldspaceBlock, public readonly origin?: string) {
    super(`Block ${block.x}, ${block.y}`, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'block';
    if (block.hasParseFailure) markFailure(this, failureNote('This block', null));
  }
}

export class SubBlockNode extends vscode.TreeItem {
  readonly kind = 'subBlock' as const;
  constructor(public readonly plugin: string, public readonly subBlock: WorldspaceSubBlock, public readonly origin?: string) {
    super(`Sub-Block ${subBlock.x}, ${subBlock.y}`, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'subBlock';
    if (subBlock.hasParseFailure) markFailure(this, failureNote('This sub-block', null));
  }
}

// xEdit's StrRight pads each grid coordinate to width 3 with leading spaces inside the angle
// brackets — not a plain decimal string. `undefined` as well as `null` because the wire's
// cellX/cellY are honestly optional.
function strRight3(n: number | null | undefined): string {
  return String(n).padStart(3, ' ');
}

export class CellNode extends vscode.TreeItem {
  readonly kind = 'cell' as const;
  constructor(public readonly plugin: string, public readonly cell: CellSummary, public readonly origin?: string) {
    // xEdit's GetDisplayName runs GetFullName before any signature branch, so FULL wins even for
    // a persistent worldspace cell. The EditorID-or-FormKey fallback below is this file's choice,
    // not xEdit's precedence.
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
    if (cell.hasParseFailure) markFailure(this, failureNote(label, null));
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
    // A group node has no record of its own, so its fact is exactly its rows', read from the
    // listing this node was built from.
    if (placed.some(p => p.hasParseFailure)) markFailure(this, failureNote('This group', null));
  }
}

export class PlacedNode extends vscode.TreeItem {
  readonly kind = 'placed' as const;
  // Same copy-identity/immutability rule as RecordNode above.
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
    if (placed.hasParseFailure) markFailure(this, failureNote(label, null));
  }
}

export class InteriorCellsNode extends vscode.TreeItem {
  readonly kind = 'interiorCells' as const;
  constructor(public readonly plugin: string, public readonly origin?: string, hasParseFailure = false) {
    super('cell - Interior', vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'interiorCells';
    if (hasParseFailure) markFailure(this, failureNote('Interior cells', null));
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

/** Shown under a row the backend has not indexed yet. Distinct from `ErrorNode`: this state
 *  clears on its own as indexing catches up, an error does not (ADR-0013). */
export class IndexingNode extends vscode.TreeItem {
  readonly kind = 'indexing' as const;
  constructor() {
    super('Still indexing…', vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'indexing';
    this.iconPath = new vscode.ThemeIcon('loading~spin');
  }
}

export type PluginTreeNode =
  | RecordTypeNode | RecordNode
  | WorldspacesNode | WorldspaceNode | BlockNode | SubBlockNode | CellNode
  | PlacedGroupNode | PlacedNode | InteriorCellsNode | InteriorLoadMoreNode
  | ErrorNode | IndexingNode;

// Record types that get their own dedicated node in the worldspace tree, keyed by raw signature —
// one source of truth, since a set membership check and a separate per-type equality check could
// drift.
const SPATIAL_NODE_FACTORIES: Record<
  string, (pluginName: string, origin: string | undefined, hasParseFailure: boolean) => PluginTreeNode
> = {
  wrld: (pluginName, origin, hasParseFailure) => new WorldspacesNode(pluginName, origin, hasParseFailure),
  cell: (pluginName, origin, hasParseFailure) => new InteriorCellsNode(pluginName, origin, hasParseFailure),
};

// Record types represented spatially in the worldspace tree — hidden from the flat type
// list. refr/achr nest under the cell hierarchy (fetchCellGroups) rather than getting a
// top-level node of their own, so they're not in SPATIAL_NODE_FACTORIES.
const SPATIAL_TYPES = new Set([...Object.keys(SPATIAL_NODE_FACTORIES), 'refr', 'achr']);

// Which raw record-type signature gets RecordNode's own containerChildType flag (Collapsed,
// expands via fetchContainerChildren) — a Quest's dialog topics/branches/scenes, a Dialog Topic's
// responses. Deliberately narrow: every other record type's RecordNode stays a plain leaf.
function containerChildTypeOf(recordType: string): 'qust' | 'dial' | undefined {
  return recordType === 'qust' || recordType === 'dial' ? recordType : undefined;
}

// ADR-0012 invariant 1: keyed by (origin, filename), so two plugins that share a filename never
// share a fact.
class PluginAddressSet {
  private readonly addresses = new Set<string>();
  private readonly names = new Set<string>();

  replace(plugins: Iterable<PluginAddress>): void {
    this.addresses.clear();
    this.names.clear();
    for (const p of plugins) {
      this.addresses.add(pluginAddressKey(p.name, p.origin));
      this.names.add(p.name.toLowerCase());
    }
  }

  has(name: string, origin: string): boolean {
    return this.addresses.has(pluginAddressKey(name, origin));
  }

  // debt #1070
  hasLoadOrderPluginNamed(name: string): boolean {
    return this.names.has(name.toLowerCase());
  }
}

type RecordPage = { items: RecordSummary[]; total: number };
type PageCache = Map<string, RecordPage>;
type CellPageCache = Map<string, { items: CellSummary[]; total: number }>;

type RecordBrowserClient = Pick<
  MEditClient,
  'getRecordTypes' | 'getRecords' | 'getWorldspaces' | 'getWorldspaceBlocks' | 'getCellReferences'
  | 'getInteriorCells' | 'getContainerChildren'
>;

export class PluginTreeProvider implements vscode.TreeDataProvider<PluginTreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<PluginTreeNode | undefined | null>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly pageCache: PageCache = new Map();
  private readonly interiorCache: CellPageCache = new Map();
  private readonly refCache = new Map<string, CellReferences>();
  // A Quest/DialogTopic row's own children, keyed the same
  // `${pluginAddressKey(plugin, origin)}::${formKey}` shape refCache already uses for a cell's own
  // references — two same-filename plugins' rows never share an entry.
  private readonly containerChildCache = new Map<string, ContainerChildSummary[]>();
  // Last load-more failure per parent, keyed by pluginAddressKey alone — interior cells are the only
  // surface that pages. Cleared on a successful retry;
  // renders as an ErrorNode alongside the still-clickable InteriorLoadMoreNode.
  private readonly interiorLoadMoreFailures = new Map<string, string>();
  // The load order's immutable plugins, pushed in from the tree's own `GET /plugins` read —
  // record/placed rows under one get a contextValue Remove's `when` clause in package.json omits
  // from its viewItem list.
  private readonly immutablePlugins = new PluginAddressSet();
  // The load order's *tracked* plugins, from the same `GET /plugins` answer the immutable
  // set comes from — never a filesystem probe from here: tracked-ness is a fact the backend
  // derives on every read.
  private readonly trackedPlugins = new PluginAddressSet();
  private readonly log: (msg: string) => void;

  constructor(private readonly repository: RecordBrowserClient, log?: (msg: string) => void) {
    this.log = log ?? (() => {});
  }

  setImmutablePlugins(plugins: Iterable<PluginAddress>): void {
    this.immutablePlugins.replace(plugins);
    this._onDidChangeTreeData.fire(undefined);
  }

  /** Replaced wholesale on every reconcile, firing a re-render rather than clearing a cache. A
   *  `.git` appearing or disappearing under a plugin's origin is a watched event that drives a
   *  reconcile, so both directions arrive on that path. */
  setTrackedPlugins(plugins: Iterable<PluginAddress>): void {
    this.trackedPlugins.replace(plugins);
    this._onDidChangeTreeData.fire(undefined);
  }

  // A plugin outside the load order (origin stated) is immutable by construction below, so it
  // never reaches the tracked/untracked distinction at all.
  private isTracked(record: { plugin: string; origin: string }): boolean {
    return this.trackedPlugins.has(record.plugin, record.origin);
  }

  // ADR-0012: a plugin outside the load order (origin stated) is read-only by construction — an
  // edit to a file the game does not load changes nothing observable — so the stated origin alone
  // decides before the immutable set is consulted.
  private isImmutable(record: { plugin: string; origin: string }, statedOrigin?: string): boolean {
    return statedOrigin !== undefined || this.immutablePlugins.has(record.plugin, record.origin);
  }

  private isPlacedImmutable(plugin: string, statedOrigin?: string): boolean {
    return statedOrigin !== undefined || this.immutablePlugins.hasLoadOrderPluginNamed(plugin);
  }

  refresh(): void {
    this.pageCache.clear();
    this.interiorCache.clear();
    this.refCache.clear();
    this.containerChildCache.clear();
    this.interiorLoadMoreFailures.clear();
    this._onDidChangeTreeData.fire(undefined);
  }

  // A field edit is the hottest path, so it gets a scoped fix rather than refresh()'s wholesale
  // cache-clear: a cache entry the record already lives in is patched in place, never
  // invalidated, so no repository call follows.
  private findCachedRecordLocation(
    plugin: string, origin: string | undefined, formKey: string,
  ): { key: string; page: RecordPage; index: number; item: RecordSummary } | undefined {
    const prefix = `${pluginAddressKey(plugin, origin)}::`;
    for (const [key, page] of this.pageCache) {
      if (!key.startsWith(prefix)) continue;
      const index = page.items.findIndex(r => r.formKey === formKey);
      if (index === -1) continue;
      const item = present(page.items[index], `cached record at index ${index}`);
      return { key, page, index, item };
    }
    return undefined;
  }

  /** Undefined when nothing has cached this record yet, which the decoration provider reads the
   *  same as 'None': nothing to badge. */
  workingTreeStateOf(plugin: string, origin: string | undefined, formKey: string): RecordSummary['workingTreeState'] | undefined {
    return this.findCachedRecordLocation(plugin, origin, formKey)?.item.workingTreeState;
  }

  /** Never downgrades Added to Modified: a create seeds no committed counterpart however many
   *  field edits follow, so overwriting it would misrepresent one existing rather than merely go
   *  stale. Returns whether a cached row existed to patch. */
  markWorkingTreeState(
    plugin: string, origin: string | undefined, formKey: string, state: RecordSummary['workingTreeState'],
  ): boolean {
    const loc = this.findCachedRecordLocation(plugin, origin, formKey);
    if (!loc) return false;
    const current = loc.item.workingTreeState;
    if (current === state || current === 'Added') return true;
    const items = [...loc.page.items];
    items[loc.index] = { ...loc.item, workingTreeState: state };
    this.pageCache.set(loc.key, { ...loc.page, items });
    this._onDidChangeTreeData.fire(undefined);
    return true;
  }

  getTreeItem(element: PluginTreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: PluginTreeNode): Promise<PluginTreeNode[]> {
    // `element` is never actually undefined here — `PluginsTreeProvider` calls this only with a
    // defined element, and it owns the root rows. This case stays only to satisfy
    // vscode.TreeDataProvider<T>'s own optional-parameter contract.
    if (!element) return [];
    if (element instanceof RecordTypeNode) return this.fetchRecords(element);
    // A Quest/DialogTopic row expanding into its own container children — not spatial
    // (WorldspacesNode/CellNode's own hierarchy), so dispatched here rather than folded into
    // getSpatialChildren below.
    if (element instanceof RecordNode && element.containerChildType) return this.fetchContainerChildren(element);
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
        new PlacedNode(element.plugin, p, element.origin, this.isPlacedImmutable(element.plugin, element.origin)));
    }
    if (element instanceof InteriorCellsNode) return this.fetchInteriorCells(element);
    return [];
  }

  // The only pagination in this provider — record-type children load in one
  // getChildren call (see fetchRecords).
  async loadMore(node: InteriorLoadMoreNode): Promise<void> {
    const parent = node.parentNode;
    const cacheKey = pluginAddressKey(parent.plugin, parent.origin);
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

  private cacheKey(node: RecordTypeNode): string {
    return `${pluginAddressKey(node.plugin, node.origin)}::${node.recordType}`;
  }

  private err(e: unknown): string {
    return errorMessage(e);
  }

  // A failed fetch renders as an ErrorNode in place of the children, never an empty list (ADR-0019).
  private async orErrorNode(op: string, build: () => Promise<PluginTreeNode[]>): Promise<PluginTreeNode[]> {
    try {
      return await build();
    } catch (e) {
      const message = this.err(e);
      this.log(`[PluginTreeProvider] ${op} failed: ${message}`);
      return [new ErrorNode(message)];
    }
  }

  // A failed load caches nothing, so the next expand retries. `load`, never `fetch`: this has
  // nothing to do with the backend seam the client folder owns.
  private async getOrLoad<T>(map: Map<string, T>, key: string, load: () => Promise<T>): Promise<T> {
    let value = map.get(key);
    if (value === undefined) {
      value = await load();
      map.set(key, value);
    }
    return value;
  }

  /** Keyed by filename rather than by a node this provider built: `PluginsTreeProvider` expands
   *  its own load-order rows, whose whole knowledge of this side is a plugin filename
   *  (ADR-0002). */
  async getPluginChildren(pluginName: string, origin?: string): Promise<PluginTreeNode[]> {
    return this.orErrorNode(`getPluginChildren(${pluginName})`, async () => {
      const types = await this.repository.getRecordTypes(pluginName, origin);
      const typesPresent = new Set(types.map(t => t.type));
      const nodes: PluginTreeNode[] = [];
      // The spatial endpoints take the same optional origin the flat record routes do
      // (RecordTypeNode below), so a plugin the load order does not name browses its own
      // worldspaces and cells instead of having them omitted entirely.
      const failureOf = new Map(types.map(t => [t.type, t.hasParseFailure] as const));
      for (const [type, makeNode] of Object.entries(SPATIAL_NODE_FACTORIES)) {
        if (typesPresent.has(type)) nodes.push(makeNode(pluginName, origin, failureOf.get(type) ?? false));
      }
      for (const t of types) {
        if (!SPATIAL_TYPES.has(t.type)) {
          nodes.push(new RecordTypeNode(pluginName, t.type, t.count, t.displayName, origin, t.hasParseFailure));
        }
      }
      return nodes;
    });
  }

  private fetchWorldspaces(node: WorldspacesNode): Promise<PluginTreeNode[]> {
    return this.orErrorNode(`fetchWorldspaces(${node.plugin})`, async () => {
      const worldspaces = await this.repository.getWorldspaces(node.plugin, node.origin);
      return worldspaces.map(w => new WorldspaceNode(node.plugin, w, node.origin));
    });
  }

  private fetchWorldspaceChildren(node: WorldspaceNode): Promise<PluginTreeNode[]> {
    return this.orErrorNode(`fetchWorldspaceChildren(${node.worldspace.formKey})`, async () => {
      const data = await this.repository.getWorldspaceBlocks(node.plugin, node.worldspace.formKey, node.origin);
      const nodes: PluginTreeNode[] = data.topCells.map(c => new CellNode(node.plugin, c, node.origin));
      nodes.push(...data.blocks.map(b => new BlockNode(node.plugin, b, node.origin)));
      return nodes;
    });
  }

  private fetchCellGroups(node: CellNode): Promise<PluginTreeNode[]> {
    return this.orErrorNode(`fetchCellGroups(${node.cell.formKey})`, async () => {
      const cacheKey = `${pluginAddressKey(node.plugin, node.origin)}::${node.cell.formKey}`;
      const refs = await this.getOrLoad(this.refCache, cacheKey,
        () => this.repository.getCellReferences(node.plugin, node.cell.formKey, node.origin));
      const groups: PlacedGroupNode[] = [];
      if (refs.persistent.length) groups.push(new PlacedGroupNode(node.plugin, node.cell.formKey, 'persistent', refs.persistent, node.origin));
      if (refs.temporary.length) groups.push(new PlacedGroupNode(node.plugin, node.cell.formKey, 'temporary', refs.temporary, node.origin));
      return groups;
    });
  }

  // A returned "dial" child is itself expandable to its Responses; every other type is a leaf.
  private fetchContainerChildren(node: RecordNode): Promise<PluginTreeNode[]> {
    return this.orErrorNode(`fetchContainerChildren(${node.record.formKey})`, async () => {
      const cacheKey = `${pluginAddressKey(node.record.plugin, node.origin)}::${node.record.formKey}`;
      const children = await this.getOrLoad(this.containerChildCache, cacheKey,
        () => this.repository.getContainerChildren(node.record.plugin, node.record.formKey, node.origin));
      return children.map(c => new RecordNode(
        c, node.origin, this.isImmutable(c, node.origin), this.isTracked(c),
        containerChildTypeOf(c.recordType), c.hasContainerChildren));
    });
  }

  private fetchInteriorCells(node: InteriorCellsNode): Promise<PluginTreeNode[]> {
    return this.orErrorNode(`fetchInteriorCells(${node.plugin})`, async () => {
      const cacheKey = pluginAddressKey(node.plugin, node.origin);
      const cached = await this.getOrLoad(this.interiorCache, cacheKey,
        () => this.repository.getInteriorCells(node.plugin, 0, PAGE_SIZE, node.origin));
      const nodes: PluginTreeNode[] = cached.items.map(c => new CellNode(node.plugin, c, node.origin));
      if (cached.total > cached.items.length) {
        nodes.push(new InteriorLoadMoreNode(node, cached.total - cached.items.length));
      }
      const failure = this.interiorLoadMoreFailures.get(cacheKey);
      if (failure) nodes.push(new ErrorNode(failure));
      return nodes;
    });
  }

  private fetchRecords(node: RecordTypeNode): Promise<PluginTreeNode[]> {
    return this.orErrorNode(`fetchRecords(${node.plugin}, ${node.recordType})`, async () => {
      // Every record of this type in one call, no "Load more…" step (plugins.md, The tree, story
      // 10). Measured, it costs nothing noticeable at the realistic worst case, and xEdit's
      // record-type group nodes load in full too.
      const cached = await this.getOrLoad(this.pageCache, this.cacheKey(node),
        () => this.repository.getRecords(node.plugin, node.recordType, 0, UNLIMITED_RECORDS, node.origin));
      // qust/dial rows are collapsible here too — a Quest reached from its flat record-type
      // listing still expands into its container children, the same mechanism
      // fetchContainerChildren uses.
      return cached.items.map(r => new RecordNode(
        r, node.origin, this.isImmutable(r, node.origin), this.isTracked(r),
        containerChildTypeOf(node.recordType), r.hasContainerChildren));
    });
  }
}

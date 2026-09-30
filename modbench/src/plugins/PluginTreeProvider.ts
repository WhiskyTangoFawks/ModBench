import * as vscode from 'vscode';
import { ErrorNode } from './errorNode';
import type {
  RecordSummary,
  WorldspaceSummary, CellSummary, PlacedSummary, WorldspaceBlock, WorldspaceSubBlock, CellReferences,
  ContainerChildSummary, MEditClient, PluginRecordTypeCount, InteriorCellBlock, InteriorCellSubBlock,
} from '../client';
import { parseRecordResourceUri, recordResourceUri } from './recordResourceUri';
import { failurePrefixIcon } from './failurePrefixIcon';
import { pluginAddressKey } from './trackedRepositories';
import { errorMessage } from '../ports/errorMessage';
import { UNLIMITED_RECORDS } from '../client';
export { headerFormKeyFor } from './formKeyIdentity';

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

type RecordRowFacts = Pick<RecordSummary, 'formKey' | 'fullName' | 'hasParseFailure' | 'parseDiagnosis'>;

// xEdit's navigator: the EditorID or FormKey as the label, the FormKey beside it, and the name
// (FULL) in its third column, which a tree row has only as its tooltip.
function describeRecordRow(item: vscode.TreeItem, record: RecordRowFacts): void {
  item.description = record.formKey;
  if (record.hasParseFailure) item.iconPath = failurePrefixIcon();
  const failure = record.hasParseFailure ? failureNote('This record', record.parseDiagnosis) : undefined;
  const lines = [record.fullName, failure].filter(line => !!line);
  item.tooltip = lines.length > 0 ? lines.join('\n') : undefined;
}

// A row with nothing beneath it has no expander (plugins.md, The tree, story 7).
function collapsibleWhen(hasChildren: boolean): vscode.TreeItemCollapsibleState {
  return hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None;
}

// This provider deliberately has no plugin-row node — the merged tree's plugin rows are
// PluginsTreeProvider's. Do not reintroduce one: reconciling a "pluginImmutable" contextValue
// with the row's own read-only-ness story is an open question.

/** What a row beneath a plugin states about that plugin, which the menus' conditions read. */
export interface PluginConditions {
  readonly tracked: boolean;
  readonly editable: boolean;
}

// A row whose plugin no caller has described offers no record edit.
const NOT_EDITABLE: PluginConditions = { tracked: false, editable: false };

// The contextValues state, on the row, refusals the backend would otherwise reach only after
// walking the whole gesture (plugins.md, Menus and keys, story 4).
function conditionedContextValue(kind: string, conditions: PluginConditions): string {
  return `${kind} ${conditions.tracked ? 'tracked' : 'untracked'}${conditions.editable ? ' editable' : ''}`;
}

export class RecordTypeNode extends vscode.TreeItem {
  readonly kind = 'recordType' as const;
  constructor(
    public readonly plugin: string,
    public readonly recordType: string,
    count: number,
    displayName: string,
    /** ADR-0012: which plugin named `plugin` this node browses. */
    public readonly origin: string,
    hasParseFailure = false,
    public readonly conditions: PluginConditions = NOT_EDITABLE,
  ) {
    // Label is the xEdit-parity display name ("Activator"); recordType (the raw
    // 4-char signature, e.g. "acti") stays the internal id — cache key, contextValue, commands.
    super(displayName, collapsibleWhen(count > 0));
    this.description = count.toLocaleString();
    this.contextValue = conditionedContextValue('recordType', conditions);
    if (hasParseFailure) markFailure(this, failureNote(displayName, null));
  }
}

export class RecordNode extends vscode.TreeItem {
  readonly kind = 'record' as const;
  // A record-scoped command acts on the clicked row's own copy of the record, so the row carries
  // which copy it is (plugin via record, origin — ADR-0012).
  constructor(
    public readonly record: RecordSummary,
    public readonly origin: string,
    public readonly conditions: PluginConditions = NOT_EDITABLE,
    // Set for a Quest or Dialog Topic — this same row type expands into their children rather
    // than forking a wrapper node the way WorldspacesNode/CellNode do, so a container's own row
    // stays a fully-affordanced record row.
    public readonly containerChildType?: 'qust' | 'dial',
    // A qust/dial row shows an expand chevron only when this is true — a Quest with zero
    // children is a leaf. From the same bulk listing `record` came from, never a per-row
    // follow-up call.
    public readonly hasContainerChildren = false,
  ) {
    const label = record.editorId ?? record.formKey;
    const collapsible = containerChildType && hasContainerChildren;
    super(label, collapsible ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    this.contextValue = conditionedContextValue('record', conditions);
    this.command = {
      command: 'modbench.record.open',
      title: 'Open Record',
      arguments: [{ formKey: record.formKey, label }],
    };
    // RecordDecorationProvider's keying identity — record.plugin (this row's own copy's owning
    // plugin, which an override stack row can differ from the RecordTypeNode's) paired with origin.
    this.resourceUri = recordResourceUri(record.plugin, origin, record.formKey);
    describeRecordRow(this, record);
  }
}

// ── Worldspace / cell / placed-object nodes ─────────────────────────

// ADR-0012: every node in the spatial chain carries its plugin's `origin` and conditions down to
// its leaves: each hop's repository call needs the one, each record row beneath the other.
export class WorldspacesNode extends vscode.TreeItem {
  readonly kind = 'worldspaces' as const;
  constructor(
    public readonly plugin: string, typeName: string, count: number, public readonly origin: string,
    hasParseFailure = false, public readonly conditions: PluginConditions = NOT_EDITABLE,
  ) {
    super(typeName, collapsibleWhen(count > 0));
    this.description = count.toLocaleString();
    this.contextValue = 'worldspaces';
    if (hasParseFailure) markFailure(this, failureNote(typeName, null));
  }
}

export class WorldspaceNode extends vscode.TreeItem {
  readonly kind = 'worldspace' as const;
  readonly formKey: string;
  readonly editorId?: string;
  constructor(
    public readonly plugin: string, public readonly worldspace: WorldspaceSummary, public readonly origin: string,
    public readonly conditions: PluginConditions = NOT_EDITABLE,
  ) {
    const label = worldspace.editorId ?? worldspace.formKey;
    super(label, collapsibleWhen(worldspace.hasChildren));
    this.formKey = worldspace.formKey;
    this.editorId = worldspace.editorId ?? undefined;
    this.contextValue = conditionedContextValue('worldspace', conditions);
    this.command = { command: 'modbench.record.open', title: 'Open Record', arguments: [{ formKey: worldspace.formKey, label }] };
    describeRecordRow(this, worldspace);
  }
}

// xEdit's TwbGroupRecord.GetShortName (wbImplementation.pas): 'Block ' / 'Sub-Block ' and the group's
// label, one number for an interior level (types 2/3) and "Hi, Lo" for an exterior one (types 4/5).
const BLOCK_LEVEL_WORDS = { block: 'Block', subBlock: 'Sub-Block' } as const;

abstract class BlockLevelNode extends vscode.TreeItem {
  constructor(
    level: keyof typeof BLOCK_LEVEL_WORDS, label: string, hasParseFailure: boolean,
    public readonly plugin: string, public readonly origin: string, public readonly conditions: PluginConditions,
  ) {
    super(`${BLOCK_LEVEL_WORDS[level]} ${label}`, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = level;
    if (hasParseFailure) markFailure(this, failureNote(`This ${BLOCK_LEVEL_WORDS[level].toLowerCase()}`, null));
  }
}

export class BlockNode extends BlockLevelNode {
  readonly kind = 'block' as const;
  constructor(plugin: string, public readonly block: WorldspaceBlock, origin: string, conditions: PluginConditions = NOT_EDITABLE) {
    super('block', `${block.x}, ${block.y}`, block.hasParseFailure, plugin, origin, conditions);
  }
}

export class SubBlockNode extends BlockLevelNode {
  readonly kind = 'subBlock' as const;
  constructor(plugin: string, public readonly subBlock: WorldspaceSubBlock, origin: string, conditions: PluginConditions = NOT_EDITABLE) {
    super('subBlock', `${subBlock.x}, ${subBlock.y}`, subBlock.hasParseFailure, plugin, origin, conditions);
  }
}

export class InteriorBlockNode extends BlockLevelNode {
  readonly kind = 'interiorBlock' as const;
  constructor(plugin: string, public readonly block: InteriorCellBlock, origin: string, conditions: PluginConditions = NOT_EDITABLE) {
    super('block', String(block.number), block.hasParseFailure, plugin, origin, conditions);
  }
}

export class InteriorSubBlockNode extends BlockLevelNode {
  readonly kind = 'interiorSubBlock' as const;
  constructor(plugin: string, public readonly subBlock: InteriorCellSubBlock, origin: string, conditions: PluginConditions = NOT_EDITABLE) {
    super('subBlock', String(subBlock.number), subBlock.hasParseFailure, plugin, origin, conditions);
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
  readonly formKey: string;
  readonly editorId?: string;
  constructor(
    public readonly plugin: string, public readonly cell: CellSummary, public readonly origin: string,
    public readonly conditions: PluginConditions = NOT_EDITABLE,
  ) {
    const label = cell.editorId
      ?? (cell.cellX != null ? `<${strRight3(cell.cellX)}, ${strRight3(cell.cellY)}>` : cell.formKey);
    super(label, collapsibleWhen(cell.hasChildren));
    this.formKey = cell.formKey;
    this.editorId = cell.editorId ?? undefined;
    this.contextValue = conditionedContextValue('cell', conditions);
    this.command = { command: 'modbench.record.open', title: 'Open Record', arguments: [{ formKey: cell.formKey, label }] };
    describeRecordRow(this, cell);
  }
}

export class PlacedGroupNode extends vscode.TreeItem {
  readonly kind = 'placedGroup' as const;
  constructor(
    public readonly plugin: string,
    public readonly cellFormKey: string,
    public readonly group: 'persistent' | 'temporary',
    public readonly placed: PlacedSummary[],
    public readonly origin: string,
    public readonly conditions: PluginConditions = NOT_EDITABLE,
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
  readonly formKey: string;
  readonly editorId?: string;
  constructor(
    public readonly plugin: string,
    public readonly placed: PlacedSummary,
    public readonly origin: string,
    conditions: PluginConditions = NOT_EDITABLE,
  ) {
    const label = placed.editorId ?? placed.baseEditorId ?? placed.formKey;
    super(label, vscode.TreeItemCollapsibleState.None);
    this.formKey = placed.formKey;
    this.editorId = placed.editorId ?? undefined;
    this.contextValue = conditionedContextValue('placed', conditions);
    this.command = { command: 'modbench.record.open', title: 'Open Record', arguments: [{ formKey: placed.formKey, label }] };
    describeRecordRow(this, placed);
  }
}

export class InteriorCellsNode extends vscode.TreeItem {
  readonly kind = 'interiorCells' as const;
  constructor(
    public readonly plugin: string, typeName: string, count: number, public readonly origin: string,
    hasParseFailure = false, public readonly conditions: PluginConditions = NOT_EDITABLE,
  ) {
    super(typeName, collapsibleWhen(count > 0));
    this.description = count.toLocaleString();
    this.contextValue = 'interiorCells';
    if (hasParseFailure) markFailure(this, failureNote(typeName, null));
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
  | PlacedGroupNode | PlacedNode | InteriorCellsNode | InteriorBlockNode | InteriorSubBlockNode
  | ErrorNode | IndexingNode;

const SPATIAL_GROUP_FACTORIES: Record<
  string,
  (pluginName: string, group: PluginRecordTypeCount, origin: string, conditions: PluginConditions) => PluginTreeNode
> = {
  wrld: (pluginName, g, origin, conditions) =>
    new WorldspacesNode(pluginName, g.displayName, g.count, origin, g.hasParseFailure, conditions),
  cell: (pluginName, g, origin, conditions) =>
    new InteriorCellsNode(pluginName, g.displayName, g.count, origin, g.hasParseFailure, conditions),
};

// Which raw record-type signature gets RecordNode's own containerChildType flag (Collapsed,
// expands via fetchContainerChildren) — a Quest's dialog topics/branches/scenes, a Dialog Topic's
// responses. Deliberately narrow: every other record type's RecordNode stays a plain leaf.
function containerChildTypeOf(recordType: string): 'qust' | 'dial' | undefined {
  return recordType === 'qust' || recordType === 'dial' ? recordType : undefined;
}

type RecordPage = { items: RecordSummary[]; total: number };
type PageCache = Map<string, RecordPage>;

type RecordBrowserClient = Pick<
  MEditClient,
  'getRecordTypes' | 'getRecords' | 'getWorldspaces' | 'getWorldspaceBlocks' | 'getCellReferences'
  | 'getInteriorCells' | 'getContainerChildren'
>;

export class PluginTreeProvider implements vscode.TreeDataProvider<PluginTreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<PluginTreeNode | undefined | null>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly _onDidReadRecords = new vscode.EventEmitter<readonly vscode.Uri[]>();
  /** The record rows a read from mEdit just answered, by resource URI. */
  readonly onDidReadRecords = this._onDidReadRecords.event;

  private readonly pageCache: PageCache = new Map();
  // Bumped by each refresh, so a read answered before mEdit's rows changed caches nothing.
  private generation = 0;
  private readonly interiorCache = new Map<string, InteriorCellBlock[]>();
  private readonly refCache = new Map<string, CellReferences>();
  private readonly containerChildCache = new Map<string, ContainerChildSummary[]>();
  private readonly log: (msg: string) => void;

  constructor(private readonly repository: RecordBrowserClient, log?: (msg: string) => void) {
    this.log = log ?? (() => {});
  }

  refresh(): void {
    this.generation++;
    this.pageCache.clear();
    this.interiorCache.clear();
    this.refCache.clear();
    this.containerChildCache.clear();
    this._onDidChangeTreeData.fire(undefined);
  }

  private cachedRecord(plugin: string, origin: string, formKey: string): RecordSummary | undefined {
    const prefix = `${pluginAddressKey(plugin, origin)}::`;
    for (const [key, page] of this.pageCache) {
      if (!key.startsWith(prefix)) continue;
      const item = page.items.find(r => r.formKey === formKey);
      if (item) return item;
    }
    return undefined;
  }

  /** Undefined for a URI that is not a record row's, and for a record nothing has cached yet, which
   *  the decoration provider reads the same as 'None': nothing to badge. */
  workingTreeStateOf(uri: vscode.Uri): RecordSummary['workingTreeState'] | undefined {
    const identity = parseRecordResourceUri(uri);
    return identity && this.cachedRecord(identity.plugin, identity.origin, identity.formKey)?.workingTreeState;
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
    if (element instanceof BlockNode) {
      return element.block.subBlocks.map(s => new SubBlockNode(element.plugin, s, element.origin, element.conditions));
    }
    if (element instanceof SubBlockNode) {
      return element.subBlock.cells.map(c => new CellNode(element.plugin, c, element.origin, element.conditions));
    }
    if (element instanceof CellNode) return this.fetchCellGroups(element);
    if (element instanceof PlacedGroupNode) {
      return element.placed.map(p =>
        new PlacedNode(element.plugin, p, element.origin, element.conditions));
    }
    if (element instanceof InteriorCellsNode) return this.fetchInteriorCells(element);
    if (element instanceof InteriorBlockNode) {
      return element.block.subBlocks.map(s => new InteriorSubBlockNode(element.plugin, s, element.origin, element.conditions));
    }
    if (element instanceof InteriorSubBlockNode) {
      return element.subBlock.cells.map(c => new CellNode(element.plugin, c, element.origin, element.conditions));
    }
    return [];
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
    const cached = map.get(key);
    if (cached !== undefined) return cached;
    const generation = this.generation;
    const value = await load();
    if (generation === this.generation) map.set(key, value);
    return value;
  }

  /** Keyed by the plugin rather than by a node this provider built: `PluginsTreeProvider` expands
   *  its own rows, whose whole knowledge of this side is the plugin (ADR-0002), and the
   *  conditions that row states. */
  async getPluginChildren(pluginName: string, origin: string, conditions: PluginConditions = NOT_EDITABLE): Promise<PluginTreeNode[]> {
    return this.orErrorNode(`getPluginChildren(${pluginName})`, async () => {
      const types = await this.repository.getRecordTypes(pluginName, origin);
      return types
        .map(t => SPATIAL_GROUP_FACTORIES[t.type]?.(pluginName, t, origin, conditions)
          ?? new RecordTypeNode(pluginName, t.type, t.count, t.displayName, origin, t.hasParseFailure, conditions));
    });
  }

  private fetchWorldspaces(node: WorldspacesNode): Promise<PluginTreeNode[]> {
    return this.orErrorNode(`fetchWorldspaces(${node.plugin})`, async () => {
      const worldspaces = await this.repository.getWorldspaces(node.plugin, node.origin);
      return worldspaces.map(w => new WorldspaceNode(node.plugin, w, node.origin, node.conditions));
    });
  }

  private fetchWorldspaceChildren(node: WorldspaceNode): Promise<PluginTreeNode[]> {
    return this.orErrorNode(`fetchWorldspaceChildren(${node.worldspace.formKey})`, async () => {
      const data = await this.repository.getWorldspaceBlocks(node.plugin, node.worldspace.formKey, node.origin);
      const nodes: PluginTreeNode[] = data.topCells.map(c => new CellNode(node.plugin, c, node.origin, node.conditions));
      nodes.push(...data.blocks.map(b => new BlockNode(node.plugin, b, node.origin, node.conditions)));
      return nodes;
    });
  }

  private fetchCellGroups(node: CellNode): Promise<PluginTreeNode[]> {
    return this.orErrorNode(`fetchCellGroups(${node.cell.formKey})`, async () => {
      const cacheKey = `${pluginAddressKey(node.plugin, node.origin)}::${node.cell.formKey}`;
      const refs = await this.getOrLoad(this.refCache, cacheKey,
        () => this.repository.getCellReferences(node.plugin, node.cell.formKey, node.origin));
      const groups: PlacedGroupNode[] = [];
      if (refs.persistent.length) groups.push(new PlacedGroupNode(node.plugin, node.cell.formKey, 'persistent', refs.persistent, node.origin, node.conditions));
      if (refs.temporary.length) groups.push(new PlacedGroupNode(node.plugin, node.cell.formKey, 'temporary', refs.temporary, node.origin, node.conditions));
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
        c, node.origin, node.conditions, containerChildTypeOf(c.recordType), c.hasContainerChildren));
    });
  }

  // Every interior cell in one call (plugins.md, The tree, story 8).
  private fetchInteriorCells(node: InteriorCellsNode): Promise<PluginTreeNode[]> {
    return this.orErrorNode(`fetchInteriorCells(${node.plugin})`, async () => {
      const blocks = await this.getOrLoad(this.interiorCache, pluginAddressKey(node.plugin, node.origin),
        () => this.repository.getInteriorCells(node.plugin, node.origin));
      return blocks.map(b => new InteriorBlockNode(node.plugin, b, node.origin, node.conditions));
    });
  }

  private fetchRecords(node: RecordTypeNode): Promise<PluginTreeNode[]> {
    return this.orErrorNode(`fetchRecords(${node.plugin}, ${node.recordType})`, async () => {
      // Every record of this type in one call, no "Load more…" step (plugins.md, The tree, story
      // 10). Measured, it costs nothing noticeable at the realistic worst case, and xEdit's
      // record-type group nodes load in full too.
      const key = this.cacheKey(node);
      const wasCached = this.pageCache.has(key);
      const cached = await this.getOrLoad(this.pageCache, key,
        () => this.repository.getRecords(node.plugin, node.recordType, 0, UNLIMITED_RECORDS, node.origin));
      const read = !wasCached && this.pageCache.get(key) === cached;
      // qust/dial rows are collapsible here too — a Quest reached from its flat record-type
      // listing still expands into its container children, the same mechanism
      // fetchContainerChildren uses.
      const rows = cached.items.map(r => new RecordNode(
        r, node.origin, node.conditions, containerChildTypeOf(node.recordType), r.hasContainerChildren));
      if (read) this._onDidReadRecords.fire(rows.map((row) => recordResourceUri(row.record.plugin, node.origin, row.record.formKey)));
      return rows;
    });
  }
}

import * as vscode from 'vscode';
import { ErrorNode } from '../drivingLib/errorNode';
import type {
  RecordSummary, RecordPage,
  WorldspaceSummary, CellSummary, ChildRecordSummary, WorldspaceBlock, WorldspaceSubBlock, CellChildRecords,
  ContainerChildSummary, MEditClient, PluginRecordTypeCount, InteriorCellBlock, InteriorCellSubBlock,
} from '../client';
import { parseRecordResourceUri, recordResourceUri } from './recordResourceUri';
import { failurePrefixIcon } from './failurePrefixIcon';
import { pluginAddressKey, pluginAddressOf, type PluginAddress } from '../wire/pluginAddress';
import type { PluginConditions } from './pluginFacts';
import { errorMessage } from '../ports/errorMessage';
import { UNLIMITED_RECORDS } from '../client';

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

// A row whose plugin no caller has described offers no record edit.
const NOT_EDITABLE: PluginConditions = { tracked: false, editable: false };

// A row opens its own plugin's copy (commands.md, Argument: "Singular means the clicked row").
function openCopyCommand(formKey: string, plugin: PluginAddress): vscode.Command {
  return { command: 'modbench.record.open', title: 'Open Record', arguments: [{ formKey, plugin }] };
}

// The contextValues state, on the row, refusals the backend would otherwise reach only after
// walking the whole gesture (plugins.md, Menus and keys, story 4).
function conditionedContextValue(kind: string, conditions: PluginConditions, isContainer = false): string {
  return `${kind} ${conditions.tracked ? 'tracked' : 'untracked'}${conditions.editable ? ' editable' : ''}${isContainer ? ' container' : ''}`;
}

class RecordTypeNode extends vscode.TreeItem {
  readonly kind = 'recordType' as const;
  readonly recordType: string;
  readonly isContainer: boolean;
  constructor(
    public readonly plugin: string,
    group: PluginRecordTypeCount,
    /** Which plugin named `plugin` this node browses (ADR-0012). */
    public readonly origin: string,
    public readonly conditions: PluginConditions = NOT_EDITABLE,
  ) {
    // Label is the xEdit-parity display name ("Activator"); recordType (the raw
    // 4-char signature, e.g. "acti") stays the internal id — cache key, contextValue, commands.
    super(group.displayName, collapsibleWhen(group.count > 0));
    this.recordType = group.type;
    this.isContainer = group.isContainer;
    this.description = group.count.toLocaleString();
    this.contextValue = conditionedContextValue('recordType', conditions) + (group.isCreatable ? ' creatable' : '');
    if (group.hasParseFailure) markFailure(this, failureNote(group.displayName, null));
  }
}

class RecordNode extends vscode.TreeItem {
  readonly kind = 'record' as const;
  // A record-scoped command acts on the clicked row's own copy of the record, so the row carries
  // which copy it is: its plugin, via the record, and its origin (ADR-0012).
  constructor(
    public readonly record: RecordSummary,
    public readonly origin: string,
    public readonly conditions: PluginConditions = NOT_EDITABLE,
    public readonly isContainer = false,
    // From the same bulk listing `record` came from, never a per-row follow-up call.
    public readonly hasContainerChildren = false,
  ) {
    const label = record.editorId ?? record.formKey;
    super(label, collapsibleWhen(isContainer && hasContainerChildren));
    this.contextValue = conditionedContextValue('record', conditions, isContainer);
    this.command = openCopyCommand(record.formKey, { name: record.plugin, origin });
    // RecordDecorationProvider's keying identity — record.plugin (this row's own copy's owning
    // plugin, which an override stack row can differ from the RecordTypeNode's) paired with origin.
    this.resourceUri = recordResourceUri({ name: record.plugin, origin }, record.formKey);
    describeRecordRow(this, record);
  }
}

// ── Worldspace / cell / child-record nodes ─────────────────────────

// Every node in the spatial chain carries its plugin's `origin` (ADR-0012) and conditions down to
// its leaves: each hop's repository call needs the one, each record row beneath the other.
class WorldspaceNode extends vscode.TreeItem {
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
    this.contextValue = conditionedContextValue('worldspace', conditions, true);
    this.command = openCopyCommand(worldspace.formKey, { name: plugin, origin });
    this.resourceUri = recordResourceUri({ name: plugin, origin }, worldspace.formKey);
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

class BlockNode extends BlockLevelNode {
  readonly kind = 'block' as const;
  constructor(plugin: string, public readonly block: WorldspaceBlock, origin: string, conditions: PluginConditions = NOT_EDITABLE) {
    super('block', `${block.x}, ${block.y}`, block.hasParseFailure, plugin, origin, conditions);
  }
}

class SubBlockNode extends BlockLevelNode {
  readonly kind = 'subBlock' as const;
  constructor(plugin: string, public readonly subBlock: WorldspaceSubBlock, origin: string, conditions: PluginConditions = NOT_EDITABLE) {
    super('subBlock', `${subBlock.x}, ${subBlock.y}`, subBlock.hasParseFailure, plugin, origin, conditions);
  }
}

class InteriorBlockNode extends BlockLevelNode {
  readonly kind = 'interiorBlock' as const;
  constructor(plugin: string, public readonly block: InteriorCellBlock, origin: string, conditions: PluginConditions = NOT_EDITABLE) {
    super('block', String(block.number), block.hasParseFailure, plugin, origin, conditions);
  }
}

class InteriorSubBlockNode extends BlockLevelNode {
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

class CellNode extends vscode.TreeItem {
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
    this.contextValue = conditionedContextValue('cell', conditions, true);
    this.command = openCopyCommand(cell.formKey, { name: plugin, origin });
    this.resourceUri = recordResourceUri({ name: plugin, origin }, cell.formKey);
    describeRecordRow(this, cell);
  }
}

class ChildRecordGroupNode extends vscode.TreeItem {
  readonly kind = 'placedGroup' as const;
  constructor(
    public readonly plugin: string,
    public readonly cellFormKey: string,
    public readonly group: 'persistent' | 'temporary',
    public readonly children: ChildRecordSummary[],
    public readonly origin: string,
    public readonly conditions: PluginConditions = NOT_EDITABLE,
  ) {
    super(group === 'persistent' ? 'Persistent' : 'Temporary', vscode.TreeItemCollapsibleState.Collapsed);
    this.description = children.length.toLocaleString();
    this.contextValue = `placedGroup-${group}`;
    // A group node has no record of its own, so its fact is exactly its rows', read from the
    // listing this node was built from.
    if (children.some(p => p.hasParseFailure)) markFailure(this, failureNote('This group', null));
  }
}

class ChildRecordNode extends vscode.TreeItem {
  readonly kind = 'placed' as const;
  readonly formKey: string;
  readonly editorId?: string;
  constructor(
    public readonly plugin: string,
    public readonly child: ChildRecordSummary,
    public readonly origin: string,
    conditions: PluginConditions = NOT_EDITABLE,
  ) {
    const label = child.editorId ?? child.baseEditorId ?? child.formKey;
    super(label, vscode.TreeItemCollapsibleState.None);
    this.formKey = child.formKey;
    this.editorId = child.editorId ?? undefined;
    this.contextValue = conditionedContextValue('placed', conditions);
    this.command = openCopyCommand(child.formKey, { name: plugin, origin });
    this.resourceUri = recordResourceUri({ name: plugin, origin }, child.formKey);
    describeRecordRow(this, child);
  }
}

/** Shown under a row the backend has not indexed yet. Distinct from `ErrorNode`: this state
 *  clears on its own as indexing catches up, an error does not (plugins.md, States, stories
 *  2 and 6). */
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
  | WorldspaceNode | BlockNode | SubBlockNode | CellNode
  | ChildRecordGroupNode | ChildRecordNode | InteriorBlockNode | InteriorSubBlockNode
  | ErrorNode | IndexingNode;

export const CELL_RECORD_TYPE = 'cell';
const WORLDSPACE_RECORD_TYPE = 'wrld';

type PageCache = Map<string, RecordPage>;

type RecordBrowserClient = Pick<
  MEditClient,
  'getRecordTypes' | 'getRecords' | 'getWorldspaces' | 'getWorldspaceBlocks' | 'getCellChildRecords'
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
  private readonly refCache = new Map<string, CellChildRecords>();
  private readonly containerChildCache = new Map<string, ContainerChildSummary[]>();
  private readonly spatialStates = new Map<string, RecordSummary['workingTreeState']>();
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
    this.spatialStates.clear();
    this._onDidChangeTreeData.fire(undefined);
  }

  private cachedRecord(plugin: PluginAddress, formKey: string): Pick<RecordSummary, 'workingTreeState'> | undefined {
    const spatial = this.spatialStates.get(`${pluginAddressKey(plugin)}::${formKey}`);
    if (spatial) return { workingTreeState: spatial };
    const prefix = `${pluginAddressKey(plugin)}::`;
    const listings = [
      ...[...this.pageCache].map(([key, page]) => [key, page.items] as const),
      ...this.containerChildCache,
    ];
    for (const [key, rows] of listings) {
      if (!key.startsWith(prefix)) continue;
      const row = rows.find(r => r.formKey === formKey);
      if (row) return row;
    }
    return undefined;
  }

  /** Undefined for a URI that is not a record row's, and for a record nothing has cached yet, which
   *  the decoration provider reads the same as 'None': nothing to badge. */
  workingTreeStateOf(uri: vscode.Uri): RecordSummary['workingTreeState'] | undefined {
    const identity = parseRecordResourceUri(uri);
    return identity && this.cachedRecord(identity.plugin, identity.formKey)?.workingTreeState;
  }

  getTreeItem(element: PluginTreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: PluginTreeNode): Promise<PluginTreeNode[]> {
    // `element` is never actually undefined here — `PluginsTreeProvider` calls this only with a
    // defined element, and it owns the root rows. This case stays only to satisfy
    // vscode.TreeDataProvider<T>'s own optional-parameter contract.
    if (!element) return [];
    if (element instanceof RecordTypeNode) return this.fetchGroup(element);
    if (element instanceof RecordNode && element.isContainer) return this.fetchContainerChildren(element);
    return this.getSpatialChildren(element);
  }

  // Dispatch for the worldspace / cell / block spatial hierarchy, split out of getChildren
  // so neither dispatch ladder exceeds the complexity budget.
  private getSpatialChildren(element: PluginTreeNode): Promise<PluginTreeNode[]> | PluginTreeNode[] {
    if (element instanceof WorldspaceNode) return this.fetchWorldspaceChildren(element);
    if (element instanceof BlockNode) {
      return element.block.subBlocks.map(s => new SubBlockNode(element.plugin, s, element.origin, element.conditions));
    }
    if (element instanceof SubBlockNode) {
      return element.subBlock.cells.map(c => new CellNode(element.plugin, c, element.origin, element.conditions));
    }
    if (element instanceof CellNode) return this.fetchCellGroups(element);
    if (element instanceof ChildRecordGroupNode) {
      return element.children.map(p =>
        new ChildRecordNode(element.plugin, p, element.origin, element.conditions));
    }
    if (element instanceof InteriorBlockNode) {
      return element.block.subBlocks.map(s => new InteriorSubBlockNode(element.plugin, s, element.origin, element.conditions));
    }
    if (element instanceof InteriorSubBlockNode) {
      return element.subBlock.cells.map(c => new CellNode(element.plugin, c, element.origin, element.conditions));
    }
    return [];
  }

  private cacheKey(node: RecordTypeNode): string {
    return `${pluginAddressKey(pluginAddressOf(node))}::${node.recordType}`;
  }

  private err(e: unknown): string {
    return errorMessage(e);
  }

  // A failed fetch renders as the error row in place of the children (plugins.md, Rows that stand
  // in for records).
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
   *  its own rows, whose whole knowledge of this side is the plugin and the
   *  conditions that row states. */
  async getPluginChildren(plugin: PluginAddress, conditions: PluginConditions = NOT_EDITABLE): Promise<PluginTreeNode[]> {
    return this.orErrorNode(`getPluginChildren(${plugin.name})`, async () => {
      const types = await this.repository.getRecordTypes(plugin);
      return types.map(t => new RecordTypeNode(plugin.name, t, plugin.origin, conditions));
    });
  }

  private fetchGroup(node: RecordTypeNode): Promise<PluginTreeNode[]> {
    if (node.recordType === WORLDSPACE_RECORD_TYPE) return this.fetchWorldspaces(node);
    if (node.recordType === CELL_RECORD_TYPE) return this.fetchInteriorCells(node);
    return this.fetchRecords(node);
  }

  private fetchWorldspaces(node: RecordTypeNode): Promise<PluginTreeNode[]> {
    return this.orErrorNode(`fetchWorldspaces(${node.plugin})`, async () => {
      const generation = this.generation;
      const worldspaces = await this.repository.getWorldspaces(pluginAddressOf(node));
      this.readSpatial(generation, pluginAddressOf(node), worldspaces);
      return worldspaces.map(w => new WorldspaceNode(node.plugin, w, node.origin, node.conditions));
    });
  }

  private fetchWorldspaceChildren(node: WorldspaceNode): Promise<PluginTreeNode[]> {
    return this.orErrorNode(`fetchWorldspaceChildren(${node.worldspace.formKey})`, async () => {
      const generation = this.generation;
      const data = await this.repository.getWorldspaceBlocks(pluginAddressOf(node), node.worldspace.formKey);
      const cells = [...data.topCells, ...data.blocks.flatMap(b => b.subBlocks.flatMap(s => s.cells))];
      this.readSpatial(generation, pluginAddressOf(node), cells);
      const nodes: PluginTreeNode[] = data.topCells.map(c => new CellNode(node.plugin, c, node.origin, node.conditions));
      nodes.push(...data.blocks.map(b => new BlockNode(node.plugin, b, node.origin, node.conditions)));
      return nodes;
    });
  }

  private fetchCellGroups(node: CellNode): Promise<PluginTreeNode[]> {
    return this.orErrorNode(`fetchCellGroups(${node.cell.formKey})`, async () => {
      const cacheKey = `${pluginAddressKey(pluginAddressOf(node))}::${node.cell.formKey}`;
      const generation = this.generation;
      const refs = await this.getOrLoad(this.refCache, cacheKey,
        () => this.repository.getCellChildRecords(pluginAddressOf(node), node.cell.formKey));
      this.readSpatial(generation, pluginAddressOf(node), [...refs.persistent, ...refs.temporary]);
      const groups: ChildRecordGroupNode[] = [];
      if (refs.persistent.length) groups.push(new ChildRecordGroupNode(node.plugin, node.cell.formKey, 'persistent', refs.persistent, node.origin, node.conditions));
      if (refs.temporary.length) groups.push(new ChildRecordGroupNode(node.plugin, node.cell.formKey, 'temporary', refs.temporary, node.origin, node.conditions));
      return groups;
    });
  }

  private fetchContainerChildren(node: RecordNode): Promise<PluginTreeNode[]> {
    return this.orErrorNode(`fetchContainerChildren(${node.record.formKey})`, async () => {
      const cacheKey = `${pluginAddressKey({ name: node.record.plugin, origin: node.origin })}::${node.record.formKey}`;
      const wasCached = this.containerChildCache.has(cacheKey);
      const children = await this.getOrLoad(this.containerChildCache, cacheKey,
        () => this.repository.getContainerChildren({ name: node.record.plugin, origin: node.origin }, node.record.formKey));
      const read = !wasCached && this.containerChildCache.get(cacheKey) === children;
      const rows = children.map(c => new RecordNode(c, node.origin, node.conditions, c.isContainer, c.hasContainerChildren));
      if (read) this.fireRead(rows);
      return rows;
    });
  }

  // Every interior cell in one call (plugins.md, The tree, story 8).
  private fetchInteriorCells(node: RecordTypeNode): Promise<PluginTreeNode[]> {
    return this.orErrorNode(`fetchInteriorCells(${node.plugin})`, async () => {
      const generation = this.generation;
      const blocks = await this.getOrLoad(this.interiorCache, pluginAddressKey(pluginAddressOf(node)),
        () => this.repository.getInteriorCells(pluginAddressOf(node)));
      this.readSpatial(generation, pluginAddressOf(node), blocks.flatMap(b => b.subBlocks.flatMap(s => s.cells)));
      return blocks.map(b => new InteriorBlockNode(node.plugin, b, node.origin, node.conditions));
    });
  }

  private fetchRecords(node: RecordTypeNode): Promise<PluginTreeNode[]> {
    return this.orErrorNode(`fetchRecords(${node.plugin}, ${node.recordType})`, async () => {
      const key = this.cacheKey(node);
      const wasCached = this.pageCache.has(key);
      const cached = await this.getOrLoad(this.pageCache, key,
        () => this.repository.getRecords(pluginAddressOf(node), node.recordType, 0, UNLIMITED_RECORDS));
      const read = !wasCached && this.pageCache.get(key) === cached;
      const rows = cached.items.map(r => new RecordNode(r, node.origin, node.conditions, node.isContainer, r.hasContainerChildren));
      if (read) this.fireRead(rows);
      return rows;
    });
  }

  private readSpatial(
    generation: number, plugin: PluginAddress, rows: readonly Pick<RecordSummary, 'formKey' | 'workingTreeState'>[],
  ): void {
    if (generation !== this.generation) return;
    for (const row of rows) this.spatialStates.set(`${pluginAddressKey(plugin)}::${row.formKey}`, row.workingTreeState);
    this._onDidReadRecords.fire(rows.map(row => recordResourceUri(plugin, row.formKey)));
  }

  private fireRead(rows: readonly RecordNode[]): void {
    this._onDidReadRecords.fire(rows.map((row) => recordResourceUri({ name: row.record.plugin, origin: row.origin }, row.record.formKey)));
  }
}

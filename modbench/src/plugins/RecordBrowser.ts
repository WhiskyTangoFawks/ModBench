import * as vscode from 'vscode';
import { ErrorNode } from '../drivingLib/errorNode';
import type {
  RecordSummary, RecordPage,
  WorldspaceSummary, CellSummary, ChildRecordSummary, WorldspaceBlock, WorldspaceSubBlock, CellChildRecords,
  ContainerChildSummary, MEditClient, PluginRecordTypeCount, InteriorCellBlock, InteriorCellSubBlock, WorkingTreeStatesBeneath,
} from '../client';
import { parseRecordResourceUri, parseRowResourceUri, recordResourceUri, rowResourceUri } from './recordResourceUri';
import type { RecordArgument } from '../drivingLib/recordArgument';
import { failurePrefixIcon } from './failurePrefixIcon';
import { pluginAddressKey, pluginAddressOf, type PluginAddress } from '../wire/pluginAddress';
import { conditionedContextValue, type PluginConditions } from '../drivingLib/recordRowContext';
import { errorMessage } from '../ports/errorMessage';
import type { SyncMessage } from '../drivingLib/syncFailureReport';
import { blankIcon } from '../drivingLib/blankIcon';
import { UNLIMITED_RECORDS } from '../client';
import { answerOf, ReadFailedError } from '../wire/readFailed';

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

// A row opens its own plugin's copy (commands.md, Argument: "Singular means the clicked row").
function openCopyCommand(formKey: string, plugin: PluginAddress): vscode.Command {
  return { command: 'modbench.record.open', title: 'Open Record', arguments: [{ argument: { kind: 'record', formKey, plugin } }] };
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
    public readonly conditions: PluginConditions,
  ) {
    // Label is the xEdit-parity display name ("Activator"); recordType (the raw
    // 4-char signature, e.g. "acti") stays the internal id — cache key, contextValue, commands.
    super(group.displayName, collapsibleWhen(group.count > 0));
    this.recordType = group.type;
    this.resourceUri = rowResourceUri({ name: plugin, origin }, group.type);
    this.iconPath = blankIcon();
    this.isContainer = group.isContainer;
    this.description = group.count.toLocaleString();
    this.contextValue = conditionedContextValue('recordType', conditions) + (group.isCreatable ? ' creatable' : '');
    if (group.hasParseFailure) markFailure(this, failureNote(group.displayName, null));
  }
}

const recordArgument = (plugin: string, origin: string, formKey: string): RecordArgument =>
  ({ kind: 'record', plugin: { name: plugin, origin }, formKey });

abstract class RecordRowNode extends vscode.TreeItem {
  readonly argument: RecordArgument;
  readonly origin: string;
  constructor(
    contextKind: string, label: string, collapsibleState: vscode.TreeItemCollapsibleState,
    { name: plugin, origin }: PluginAddress, row: RecordRowFacts, conditions: PluginConditions, isContainer = false,
  ) {
    super(label, collapsibleState);
    this.origin = origin;
    this.argument = recordArgument(plugin, origin, row.formKey);
    this.contextValue = conditionedContextValue(contextKind, conditions, isContainer);
    this.command = openCopyCommand(row.formKey, { name: plugin, origin });
    // RecordDecorationProvider's keying identity: the row's own copy's owning plugin (which an
    // override stack row can differ from the RecordTypeNode's) paired with origin.
    this.resourceUri = recordResourceUri({ name: plugin, origin }, row.formKey);
    describeRecordRow(this, row);
  }
}

class RecordNode extends RecordRowNode {
  readonly kind = 'record' as const;
  constructor(
    public readonly record: RecordSummary,
    origin: string,
    public readonly conditions: PluginConditions,
    public readonly isContainer: boolean,
    // From the same bulk listing `record` came from, never a per-row follow-up call.
    public readonly hasContainerChildren: boolean,
  ) {
    super('record', record.editorId ?? record.formKey, collapsibleWhen(isContainer && hasContainerChildren),
      { name: record.plugin, origin }, record, conditions, isContainer);
  }
}

// ── Worldspace / cell / child-record nodes ─────────────────────────

// Every node in the spatial chain carries its plugin's `origin` (ADR-0012) and conditions down to
// its leaves: each hop's repository call needs the one, each record row beneath the other.
class WorldspaceNode extends RecordRowNode {
  readonly kind = 'worldspace' as const;
  readonly formKey: string;
  readonly editorId?: string;
  constructor(
    public readonly plugin: string, public readonly worldspace: WorldspaceSummary, origin: string,
    public readonly conditions: PluginConditions,
  ) {
    super('worldspace', worldspace.editorId ?? worldspace.formKey, collapsibleWhen(worldspace.hasChildren),
      { name: plugin, origin }, worldspace, conditions, true);
    this.formKey = worldspace.formKey;
    this.editorId = worldspace.editorId ?? undefined;
  }
}

// xEdit's TwbGroupRecord.GetShortName (wbImplementation.pas): 'Block ' / 'Sub-Block ' and the group's
// label, one number for an interior level (types 2/3) and "Hi, Lo" for an exterior one (types 4/5).
const BLOCK_LEVEL_WORDS = { block: 'Block', subBlock: 'Sub-Block' } as const;

type BlockSource = WorldspaceBlock | WorldspaceSubBlock | InteriorCellBlock | InteriorCellSubBlock;

const BLOCK_LEVEL_OF = { block: 'block', subBlock: 'subBlock', interiorBlock: 'block', interiorSubBlock: 'subBlock' } as const;

type BlockLevelKind = keyof typeof BLOCK_LEVEL_OF;

const blockId = (source: BlockSource): string => 'x' in source ? `${source.x},${source.y}` : String(source.number);
const blockLabel = (source: BlockSource): string => 'x' in source ? `${source.x}, ${source.y}` : String(source.number);

class BlockLevelNode extends vscode.TreeItem {
  constructor(
    public readonly kind: BlockLevelKind, public readonly source: BlockSource,
    public readonly plugin: string, public readonly origin: string, public readonly conditions: PluginConditions,
    /** The row's place beneath its plugin: what its URI and its children's are built from. */
    public readonly path: readonly string[],
  ) {
    const level = BLOCK_LEVEL_OF[kind];
    super(`${BLOCK_LEVEL_WORDS[level]} ${blockLabel(source)}`, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = level;
    this.iconPath = blankIcon();
    if (source.hasParseFailure) markFailure(this, failureNote(`This ${BLOCK_LEVEL_WORDS[level].toLowerCase()}`, null));
  }
}

// xEdit's StrRight pads each grid coordinate to width 3 with leading spaces inside the angle
// brackets — not a plain decimal string. `undefined` as well as `null` because the wire's
// cellX/cellY are honestly optional.
function strRight3(n: number | null | undefined): string {
  return String(n).padStart(3, ' ');
}

class CellNode extends RecordRowNode {
  readonly kind = 'cell' as const;
  readonly formKey: string;
  readonly editorId?: string;
  constructor(
    public readonly plugin: string, public readonly cell: CellSummary, origin: string,
    public readonly conditions: PluginConditions,
  ) {
    const label = cell.editorId
      ?? (cell.cellX != null ? `<${strRight3(cell.cellX)}, ${strRight3(cell.cellY)}>` : cell.formKey);
    super('cell', label, collapsibleWhen(cell.hasChildren), { name: plugin, origin }, cell, conditions, true);
    this.formKey = cell.formKey;
    this.editorId = cell.editorId ?? undefined;
  }
}

class ChildRecordGroupNode extends vscode.TreeItem {
  readonly kind = 'placedGroup' as const;
  readonly path: readonly string[];
  constructor(
    public readonly plugin: string,
    public readonly cellFormKey: string,
    public readonly group: 'persistent' | 'temporary',
    public readonly children: ChildRecordSummary[],
    public readonly origin: string,
    public readonly conditions: PluginConditions,
  ) {
    super(group === 'persistent' ? 'Persistent' : 'Temporary', vscode.TreeItemCollapsibleState.Collapsed);
    this.path = [cellFormKey, group];
    this.iconPath = blankIcon();
    this.description = children.length.toLocaleString();
    this.contextValue = `placedGroup-${group}`;
    // A group node has no record of its own, so its fact is exactly its rows', read from the
    // listing this node was built from.
    if (children.some(p => p.hasParseFailure)) markFailure(this, failureNote('This group', null));
  }
}

class ChildRecordNode extends RecordRowNode {
  readonly kind = 'placed' as const;
  readonly formKey: string;
  readonly editorId?: string;
  constructor(
    public readonly plugin: string,
    public readonly child: ChildRecordSummary,
    origin: string,
    conditions: PluginConditions,
  ) {
    super('placed', child.editorId ?? child.baseEditorId ?? child.formKey, vscode.TreeItemCollapsibleState.None,
      { name: plugin, origin }, child, conditions);
    this.formKey = child.formKey;
    this.editorId = child.editorId ?? undefined;
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

export type RecordBrowserNode =
  | RecordTypeNode | RecordNode | WorldspaceNode | BlockLevelNode | CellNode
  | ChildRecordGroupNode | ChildRecordNode
  | ErrorNode | IndexingNode;

export const CELL_RECORD_TYPE = 'cell';
const WORLDSPACE_RECORD_TYPE = 'wrld';

interface Listings {
  records: RecordPage;
  interior: InteriorCellBlock[];
  cellRefs: CellChildRecords;
  containerChildren: ContainerChildSummary[];
}
type Listing = Listings[keyof Listings];

type FoldedRow = Pick<RecordSummary, 'formKey' | 'workingTreeState'>;
type RowRead = FoldedRow & { readonly plugin: PluginAddress };
type WorkingTreeState = RecordSummary['workingTreeState'];

const rowKey = (uri: vscode.Uri) => `${uri.scheme}:${uri.path}`;

const foldKey = (plugin: PluginAddress, path: readonly string[]) => JSON.stringify([pluginAddressKey(plugin), path]);

function distinctChanges(states: readonly WorkingTreeState[]): WorkingTreeState[] {
  return [...new Set(states.filter(state => state !== 'None'))];
}

// The one key of everything cached: a plugin's address (ADR-0012), what is cached of it, and which.
function cacheKey(plugin: PluginAddress, scope: keyof Listings | 'row', id = ''): string {
  return `${pluginAddressKey(plugin)}::${scope}::${id}`;
}

type RecordBrowserClient = Pick<
  MEditClient,
  'getRecordTypes' | 'getRecords' | 'getWorldspaces' | 'getWorldspaceBlocks' | 'getCellChildRecords'
  | 'getInteriorCells' | 'getContainerChildren' | 'getWorkingTreeStatesBeneath'
>;

export class RecordBrowser implements vscode.TreeDataProvider<RecordBrowserNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<RecordBrowserNode | undefined | null>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly _onDidReadRecords = new vscode.EventEmitter<readonly vscode.Uri[]>();
  /** The record rows a read from mEdit just answered, by resource URI. */
  readonly onDidReadRecords = this._onDidReadRecords.event;
  private readonly _onDidReadBeneath = new vscode.EventEmitter<void>();
  /** Every row's states beneath it may have changed. */
  readonly onDidReadBeneath = this._onDidReadBeneath.event;

  private readonly listings = new Map<string, Listing>();
  private readonly rowStates = new Map<string, RecordSummary['workingTreeState']>();
  private readonly beneath = new Map<string, { generation: number; answer: WorkingTreeStatesBeneath }>();
  private readonly beneathLoading = new Set<string>();
  private readonly beneathFailures = new Map<string, string>();
  private readonly _onDidChangeBeneathFailure = new vscode.EventEmitter<void>();
  // The rows under a block or a group, whose own states fold into its badge.
  private readonly folds = new Map<string, readonly FoldedRow[]>();
  private expanded = new Set<string>();
  // Rows that were expanded before the last refresh: expanded again once the tree asks for their children.
  private reopening = new Set<string>();
  // Bumped by each refresh, so a read answered before mEdit's rows changed caches nothing.
  private generation = 0;
  constructor(private readonly repository: RecordBrowserClient) {}

  refresh(): void {
    this.generation++;
    this.listings.clear();
    this.rowStates.clear();
    this.beneathLoading.clear();
    this.folds.clear();
    this.reopening = new Set([...this.reopening, ...this.expanded]);
    this.dropBeneathFailures();
    this.expanded = new Set();
    this._onDidChangeTreeData.fire(undefined);
    this._onDidReadBeneath.fire();
  }

  /** Undefined for a URI that is not a record row's, and for a record nothing has cached yet, which
   *  the decoration provider reads the same as 'None': nothing to badge. */
  workingTreeStateOf(uri: vscode.Uri): RecordSummary['workingTreeState'] | undefined {
    const identity = parseRecordResourceUri(uri);
    return identity && this.rowStates.get(cacheKey(identity.plugin, 'row', identity.formKey));
  }

  /** The distinct changes strictly beneath the row, never its own. An answer older than the last refresh
   *  is shown until its replacement lands. */
  statesBeneathOf(uri: vscode.Uri): readonly WorkingTreeState[] {
    const identity = parseRecordResourceUri(uri) ?? parseRowResourceUri(uri);
    if (identity === undefined) return [];
    const answer = this.beneathOf(identity.plugin);
    if (answer === undefined) return [];
    if ('formKey' in identity) return answer.records[identity.formKey] ?? [];
    const fold = this.folds.get(foldKey(identity.plugin, identity.path));
    if (fold !== undefined) {
      return distinctChanges(fold.flatMap(row => [row.workingTreeState, ...(answer.records[row.formKey] ?? [])]));
    }
    const [recordType] = identity.path;
    return recordType === undefined ? answer.plugin : answer.recordTypes[recordType] ?? [];
  }

  private beneathOf(plugin: PluginAddress): WorkingTreeStatesBeneath | undefined {
    const key = pluginAddressKey(plugin);
    const held = this.beneath.get(key);
    if (held?.generation !== this.generation) this.loadBeneath(plugin, key);
    return held?.answer;
  }

  // A failed read is not retried until the next refresh, so no row asks again.
  private loadBeneath(plugin: PluginAddress, key: string): void {
    if (this.beneathLoading.has(key)) return;
    this.beneathLoading.add(key);
    const generation = this.generation;
    this.repository.getWorkingTreeStatesBeneath(plugin).then(answerOf).then((answer) => {
      if (generation !== this.generation) return;
      this.beneath.set(key, { generation, answer });
      this._onDidReadBeneath.fire();
      if (this.beneathFailures.delete(key)) this._onDidChangeBeneathFailure.fire();
    }, (e: unknown) => {
      if (generation !== this.generation) return;
      const reason = this.err(e);
      const message = this.beneath.has(key) ? `Showing the last good read: ${reason}` : `Failed to load: ${reason}`;
      if (this.beneathFailures.get(key) !== message) {
        this.beneathFailures.set(key, message);
        this._onDidChangeBeneathFailure.fire();
      }
    });
  }

  // A failure stands until its plugin reads well; a plugin that left the tree never will, so each
  // refresh forgets them and the rows still shown ask again.
  private dropBeneathFailures(): void {
    if (this.beneathFailures.size === 0) return;
    this.beneathFailures.clear();
    this._onDidChangeBeneathFailure.fire();
  }

  /** The message line's part when the states beneath the rows could not be read (common.md, States,
   *  stories 2 and 6): the rows keep the last answer. */
  readonly beneathFailure: SyncMessage = {
    message: () => this.beneathFailures.values().next().value,
    onMessageChanged: (listener) => this._onDidChangeBeneathFailure.event(listener),
  };

  isExpanded(uri: vscode.Uri): boolean {
    return this.expanded.has(rowKey(uri));
  }

  expandedRow(uri: vscode.Uri): void {
    this.expanded.add(rowKey(uri));
    this._onDidReadRecords.fire([uri]);
  }

  collapsedRow(uri: vscode.Uri): void {
    this.expanded.delete(rowKey(uri));
    this.reopening.delete(rowKey(uri));
    this._onDidReadRecords.fire([uri]);
  }

  /** VS Code asks for the children of the rows it keeps expanded across a rebuild, and of no
   *  others: the one caller that says so is the tree answering VS Code. */
  reopen(uri: vscode.Uri): void {
    if (!this.reopening.delete(rowKey(uri))) return;
    this.expanded.add(rowKey(uri));
    this._onDidReadRecords.fire([uri]);
  }

  private folded<N extends vscode.TreeItem & { plugin: string; origin: string; path: readonly string[] }>(
    node: N, rows: readonly FoldedRow[],
  ): N {
    const plugin = pluginAddressOf(node);
    node.resourceUri = rowResourceUri(plugin, ...node.path);
    this.folds.set(foldKey(plugin, node.path), rows);
    this._onDidReadRecords.fire([node.resourceUri]);
    return node;
  }

  getTreeItem(element: RecordBrowserNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: RecordBrowserNode): Promise<RecordBrowserNode[]> {
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
  private getSpatialChildren(element: RecordBrowserNode): Promise<RecordBrowserNode[]> | RecordBrowserNode[] {
    if (element instanceof WorldspaceNode) return this.fetchWorldspaceChildren(element);
    if (element instanceof BlockLevelNode) return this.blockLevelChildren(element);
    if (element instanceof CellNode) return this.fetchCellGroups(element);
    if (element instanceof ChildRecordGroupNode) {
      return element.children.map(p =>
        new ChildRecordNode(element.plugin, p, element.origin, element.conditions));
    }
    return [];
  }

  private blockLevelChildren(node: BlockLevelNode): RecordBrowserNode[] {
    const { source } = node;
    if (!('subBlocks' in source)) {
      return source.cells.map(c => new CellNode(node.plugin, c, node.origin, node.conditions));
    }
    const kind = 'x' in source ? 'subBlock' : 'interiorSubBlock';
    return source.subBlocks.map(s => this.folded(
      new BlockLevelNode(kind, s, node.plugin, node.origin, node.conditions, [...node.path, blockId(s)]), s.cells));
  }

  private err(e: unknown): string {
    return errorMessage(e);
  }

  // A failed fetch renders as the error row in place of the children (plugins.md, Rows that stand
  // in for records).
  private async orErrorNode(build: () => Promise<RecordBrowserNode[]>): Promise<RecordBrowserNode[]> {
    try {
      return await build();
    } catch (e) {
      if (!(e instanceof ReadFailedError)) throw e;
      return [new ErrorNode(this.err(e))];
    }
  }

  // A failed load caches nothing, so the next expand retries. `load`, never `fetch`: this has
  // nothing to do with the backend seam the client folder owns.
  private getOrLoad<S extends keyof Listings>(
    scope: S, plugin: PluginAddress, id: string, load: () => Promise<Listings[S]>,
  ): Promise<Listings[S]>;
  private async getOrLoad(scope: keyof Listings, plugin: PluginAddress, id: string, load: () => Promise<Listing>): Promise<Listing> {
    const key = cacheKey(plugin, scope, id);
    const cached = this.listings.get(key);
    if (cached !== undefined) return cached;
    const generation = this.generation;
    const value = await load();
    if (generation === this.generation) this.listings.set(key, value);
    return value;
  }

  /** Keyed by the plugin rather than by a node this provider built: `PluginsTreeProvider` expands
   *  its own rows, whose whole knowledge of this side is the plugin and the
   *  conditions that row states. */
  async getPluginChildren(plugin: PluginAddress, conditions: PluginConditions): Promise<RecordBrowserNode[]> {
    return this.orErrorNode(async () => {
      const types = answerOf(await this.repository.getRecordTypes(plugin));
      return types.map(t => new RecordTypeNode(plugin.name, t, plugin.origin, conditions));
    });
  }

  private fetchGroup(node: RecordTypeNode): Promise<RecordBrowserNode[]> {
    if (node.recordType === WORLDSPACE_RECORD_TYPE) return this.fetchWorldspaces(node);
    if (node.recordType === CELL_RECORD_TYPE) return this.fetchInteriorCells(node);
    return this.fetchRecords(node);
  }

  private fetchWorldspaces(node: RecordTypeNode): Promise<RecordBrowserNode[]> {
    return this.orErrorNode(async () => {
      const generation = this.generation;
      const worldspaces = answerOf(await this.repository.getWorldspaces(pluginAddressOf(node)));
      this.readRows(generation, worldspaces.map(w => ({ ...w, plugin: pluginAddressOf(node) })));
      return worldspaces.map(w => new WorldspaceNode(node.plugin, w, node.origin, node.conditions));
    });
  }

  private fetchWorldspaceChildren(node: WorldspaceNode): Promise<RecordBrowserNode[]> {
    return this.orErrorNode(async () => {
      const generation = this.generation;
      const data = answerOf(await this.repository.getWorldspaceBlocks(pluginAddressOf(node), node.worldspace.formKey));
      const cells = [...data.topCells, ...data.blocks.flatMap(b => b.subBlocks.flatMap(s => s.cells))];
      this.readRows(generation, cells.map(c => ({ ...c, plugin: pluginAddressOf(node) })));
      const nodes: RecordBrowserNode[] = data.topCells.map(c => new CellNode(node.plugin, c, node.origin, node.conditions));
      nodes.push(...data.blocks.map(b => this.folded(
        new BlockLevelNode('block', b, node.plugin, node.origin, node.conditions, [node.formKey, blockId(b)]), b.subBlocks.flatMap(s => s.cells))));
      return nodes;
    });
  }

  private fetchCellGroups(node: CellNode): Promise<RecordBrowserNode[]> {
    return this.orErrorNode(async () => {
      const generation = this.generation;
      const refs = await this.getOrLoad('cellRefs', pluginAddressOf(node), node.cell.formKey,
        async () => answerOf(await this.repository.getCellChildRecords(pluginAddressOf(node), node.cell.formKey)));
      this.readRows(generation, [...refs.persistent, ...refs.temporary].map(r => ({ ...r, plugin: pluginAddressOf(node) })));
      const groups: ChildRecordGroupNode[] = [];
      if (refs.persistent.length) groups.push(this.folded(new ChildRecordGroupNode(node.plugin, node.cell.formKey, 'persistent', refs.persistent, node.origin, node.conditions), refs.persistent));
      if (refs.temporary.length) groups.push(this.folded(new ChildRecordGroupNode(node.plugin, node.cell.formKey, 'temporary', refs.temporary, node.origin, node.conditions), refs.temporary));
      return groups;
    });
  }

  private fetchContainerChildren(node: RecordNode): Promise<RecordBrowserNode[]> {
    return this.orErrorNode(async () => {
      const owner = { name: node.record.plugin, origin: node.origin };
      const generation = this.generation;
      const children = await this.getOrLoad('containerChildren', owner, node.record.formKey, async () => {
        const loaded = answerOf(await this.repository.getContainerChildren(owner, node.record.formKey));
        this.readRecords(generation, node.origin, loaded);
        return loaded;
      });
      return children.map(c => new RecordNode(c, node.origin, node.conditions, c.isContainer, c.hasContainerChildren));
    });
  }

  // Every interior cell in one call (plugins.md, The tree, story 8).
  private fetchInteriorCells(node: RecordTypeNode): Promise<RecordBrowserNode[]> {
    return this.orErrorNode(async () => {
      const generation = this.generation;
      const blocks = await this.getOrLoad('interior', pluginAddressOf(node), '',
        async () => answerOf(await this.repository.getInteriorCells(pluginAddressOf(node))));
      this.readRows(generation, blocks.flatMap(b => b.subBlocks.flatMap(s => s.cells)).map(c => ({ ...c, plugin: pluginAddressOf(node) })));
      return blocks.map(b => this.folded(
        new BlockLevelNode('interiorBlock', b, node.plugin, node.origin, node.conditions, [node.recordType, blockId(b)]), b.subBlocks.flatMap(s => s.cells)));
    });
  }

  private fetchRecords(node: RecordTypeNode): Promise<RecordBrowserNode[]> {
    return this.orErrorNode(async () => {
      const generation = this.generation;
      const page = await this.getOrLoad('records', pluginAddressOf(node), node.recordType, async () => {
        const loaded = answerOf(await this.repository.getRecords(pluginAddressOf(node), node.recordType, 0, UNLIMITED_RECORDS));
        this.readRecords(generation, node.origin, loaded.items);
        return loaded;
      });
      return page.items.map(r => new RecordNode(r, node.origin, node.conditions, node.isContainer, r.hasContainerChildren));
    });
  }

  private readRecords(generation: number, origin: string, rows: readonly RecordSummary[]): void {
    this.readRows(generation, rows.map(r => ({ ...r, plugin: { name: r.plugin, origin } })));
  }

  private readRows(generation: number, rows: readonly RowRead[]): void {
    if (generation !== this.generation) return;
    for (const row of rows) this.rowStates.set(cacheKey(row.plugin, 'row', row.formKey), row.workingTreeState);
    this._onDidReadRecords.fire(rows.map(row => recordResourceUri(row.plugin, row.formKey)));
  }
}

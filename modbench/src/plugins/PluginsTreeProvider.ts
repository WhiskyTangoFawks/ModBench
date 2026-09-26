import * as vscode from 'vscode';
import type {
  MasterIssue, PluginDiagnosisReport, PluginLoadFailure, PluginMetadata, MEditClient, LoadOrderRefusal, PluginAddress,
} from '../client';
import type { InstanceValue, InstanceView, PluginEntry } from '../instanceLoader/instance';
import { firstReadOf, type FirstRead } from './instanceFirstRead';
import type { Reporter } from '../ports/reporter';
import type { ImplicitMasterSource, PluginsDrop } from '../pluginsCommands/plugins';
import { moveOrderRefusal, type PluginOrderFacts, type PluginOrderFactsOf } from '../pluginsCommands/pluginOrder';
import { failurePrefixIcon } from './failurePrefixIcon';
import { lockedRowUri } from './ImplicitMasterDecorationProvider';
import { IndexingNode, type PluginConditions, type PluginTreeNode, type PluginTreeProvider } from './PluginTreeProvider';
import { ErrorNode } from './errorNode';
import { pluginAddressKey } from './trackedRepositories';
import { errorMessage } from '../ports/errorMessage';
import { DATA_DIRECTORY_ORIGIN, OVERWRITE_ORIGIN } from '../instanceLoader/loadOrderSnapshot';

const DND_MIME = 'application/vnd.medit.pluginlist-node';

// `DataTransferItem.value` is `any` — handleDrag, above `handleDrop` below, is this provider's
// only writer of it. Exported so a test narrows the same payload the same way, instead of a
// second cast of its own.
export function isDropPayload(value: unknown): value is { names: string[] } {
  if (typeof value !== 'object' || value === null) return false;
  const witness = value as { names?: unknown };
  return Array.isArray(witness.names) && witness.names.every((n): n is string => typeof n === 'string');
}

// toolbox.ts's composition root always wires a real RecordBrowser; reaching this means a test
// exercised rows with none.
const NO_RECORD_BROWSER = 'mEdit is not connected.';
const noRecordBrowser = (): [ErrorNode] => [new ErrorNode(NO_RECORD_BROWSER)];

// Hoisted out of the constructor so an omitted dependency is not a fresh closure per instance.
const NO_DATA_FOLDER_FILE = (): string | undefined => undefined;
const NO_IMPLICIT_MASTERS: ImplicitMasterSource = () => Promise.resolve([]);

/** `reorderPlugins`, bound to the instance root and the active profile by the composition root;
 *  a refused command reaches this provider as a rejection. Enable/disable reaches its own core
 *  directly, never through the tree. */
export interface PluginListSource {
  reorderPlugins(pluginNames: string[], drop: PluginsDrop): Promise<void>;
}

/** The mEdit reads every plugin-keyed fact comes from — the port narrowed to what this tree
 *  calls. Pulled once per reconcile, never per rendered row; and its attaching, which makes the
 *  locked plugins askable. */
export type PluginFactsClient = Pick<MEditClient, 'getPlugins' | 'getDiagnoses' | 'onStatusChanged'>;

/** The record browser a row's children are delegated to (ADR-0002). `PluginTreeProvider`
 *  satisfies it. */
export type RecordBrowser = Pick<
  PluginTreeProvider,
  'getPluginChildren' | 'getChildren' | 'getTreeItem' | 'onDidChangeTreeData'
  | 'setImmutablePlugins' | 'setTrackedPlugins'
>;

/** One held plugin as the record filter's own state reads it. The reconcile hands these back so
 *  the caller needs no second `GET /plugins` for the same answer. */
export interface PluginMatch {
  name: string;
  hasMatchingRecords: boolean;
}

export interface PluginsTreeProviderOptions {
  /** Name, origin, slot, enabled and winning for every plugin — the row input (ADR-0015). */
  instance: InstanceView;
  source: PluginListSource;
  /** A row's children. Absent in tests that exercise rows alone. */
  records?: RecordBrowser;
  /** Every plugin-keyed fact. Absent in tests that exercise rows alone. */
  client?: PluginFactsClient;
  /** The malformed-plugin scan's other surface, the Problems panel, which needs an instance root
   *  this provider has no business knowing. */
  publishDiagnoses?: (reports: PluginDiagnosisReport[]) => void;
  /** ADR-0019: this provider states the severity, so a background blip and a failed read do not
   *  land on the same channel level. */
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
  reporter?: Reporter;
  /** The Instance adapter's path of a file at the root of the Data folder, read fresh at each
   *  call: the game folder setting is editable while Modbench runs. `undefined` while the folder
   *  is not found. */
  dataFolderFile?: (name: string) => string | undefined;
  /** The rows the game forces on, which only the backend can name (ADR-0016). `undefined` — it
   *  could not be reached — renders no implicit row rather than a guessed one. */
  implicitMasters?: ImplicitMasterSource;
}


// plugins.md, A row, Identity: VS Code keeps expansion and selection across a rebuild by it, and
// refuses two rows that share one.
function rowIdentity(kind: string, plugin: PluginAddress, formKey?: string): string {
  return [kind, pluginAddressKey(plugin.name, plugin.origin), ...(formKey === undefined ? [] : [formKey])].join(':');
}

/** No `resourceUri`: VS Code infers a base icon from one unless `iconPath` overrides it, so
 *  setting one would silently change every row's icon. Overridden plugins are registered
 *  (ADR-0013), not displayed. */
export class PluginNode extends vscode.TreeItem {
  readonly kind = 'plugin' as const;
  constructor(
    public readonly plugin: PluginEntry,
    /** ADR-0012: which plugin of the name this row stands for — the join key for every fact. */
    public readonly origin: string,
  ) {
    super(plugin.name, vscode.TreeItemCollapsibleState.None);
    this.id = rowIdentity(this.kind, { name: plugin.name, origin });
    this.contextValue = `plugin ${plugin.enabled ? 'enabled' : 'disabled'}`;
    // xEdit parity: selecting a plugin node shows its File Header, with no separate affordance.
    // plugins.md, Menus and keys, story 4: the game loads no disabled plugin's records, so a click
    // on its row only selects it.
    if (plugin.enabled) this.command = { command: 'modbench.openHeader', title: 'Open Header', arguments: [this] };
    this.checkboxState = plugin.enabled
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
  }
}

/** MO2's checked-but-disabled checkbox is not reproducible: `TreeItemCheckboxState` has no
 *  non-interactive variant, so a rendered checkbox would invite a toggle the extension must
 *  revert. A lock substitutes (ADR-0017). */
export class ImplicitMasterNode extends vscode.TreeItem {
  readonly kind = 'implicitMaster' as const;
  constructor(public readonly name: string, public readonly origin: string, path?: string) {
    super(name, vscode.TreeItemCollapsibleState.None);
    this.id = rowIdentity(this.kind, { name, origin });
    this.contextValue = 'pluginImplicit';
    this.iconPath = new vscode.ThemeIcon('lock');
    // plugins.md, A plugin the game loads with no line: MO2's one sentence alone — the label
    // already shows the greyed file name, so the tooltip does not repeat it.
    this.tooltip = "This plugin can't be disabled or moved (enforced by the game).";
    // Routed through the modbench.openHeader bridge command, as PluginNode's row click is.
    this.command = { command: 'modbench.openHeader', title: 'Open Header', arguments: [this] };
    if (path !== undefined) this.resourceUri = lockedRowUri(path);
  }
}

/** CONTEXT.md, Sort direction: which end of the load order the view shows at the top. */
export type SortDirection = 'losingAtTop' | 'winningAtTop';

const LOSING_END: PluginsDrop = { kind: 'losingEnd' };
const WINNING_END: PluginsDrop = { kind: 'winningEnd' };

/** plugins.md, States, story 1: an empty list says so on the message line, never as a row. */
export const NO_PLUGINS_MESSAGE =
  'No plugins: plugins.txt lists none, and mEdit names none the game loads on its own. Create Plugin…, in the title bar, adds one.';

export type PluginListNode = PluginNode | ImplicitMasterNode;

/** What this tree hands VS Code: a load-order row, or one of the record browser's nodes under
 *  it. */
export type PluginsTreeNode = PluginListNode | PluginTreeNode;

// The view is shared, so a drop must be able to tell these rows from another provider's.
const OWN_ROW_KINDS = new Set<string>(['plugin', 'implicitMaster']);

/** The plugin file a row stands for, and its label. */
export function pluginFileOf(node: PluginListNode): string {
  return node.kind === 'plugin' ? node.plugin.name : node.name;
}

// Everything one `GET /plugins` read knows about one plugin. One value rather than three
// parallel collections: they arrive together, change together, and are keyed the same way.
interface PluginFacts {
  readOnly?: boolean;
  tracked?: boolean;
  masterIssues?: MasterIssue[];
  // Whether this plugin holds a record that could not be read into its document.
  parseFailure?: boolean;
  order?: PluginOrderFacts;
}

// ADR-0012: plugin identity is origin plus filename, so every fact is filed under both.
class ByPluginAddress<T> {
  private readonly byAddress = new Map<string, T>();
  private readonly byName = new Map<string, T>();

  set(name: string, origin: string | undefined, value: T): void {
    this.byAddress.set(pluginAddressKey(name, origin), value);
    this.byName.set(name.toLowerCase(), value);
  }

  // Each index accumulates on its own: the name-only fallback reads as every plugin's lines
  // together, a plugin's own key as its own. `this` narrows to an array-valued instance.
  append<U>(this: ByPluginAddress<U[]>, name: string, origin: string | undefined, item: U): void {
    const addressKey = pluginAddressKey(name, origin);
    const nameKey = name.toLowerCase();
    this.byAddress.set(addressKey, [...(this.byAddress.get(addressKey) ?? []), item]);
    this.byName.set(nameKey, [...(this.byName.get(nameKey) ?? []), item]);
  }

  get(name: string, origin: string | undefined): T | undefined {
    return origin === undefined
      ? this.byName.get(name.toLowerCase())
      : this.byAddress.get(pluginAddressKey(name, origin));
  }

  has(name: string, origin: string): boolean {
    return this.byAddress.has(pluginAddressKey(name, origin));
  }
}

type RowDecoration = {
  description: vscode.TreeItem['description'];
  iconPath: vscode.TreeItem['iconPath'];
};

// plugins.md, States 3-4: what a row not resolved by the load order shows. `everyRow`: a second
// window (ADR-0009 point 5). `unheldRow`: mEdit unreachable, or a `Failed` reconcile.
type ExpansionOverride = { scope: 'everyRow' | 'unheldRow'; message: string };

// plugins.md, A row: the four statuses, in the order that sets the icon. `words` is the
// description's vocabulary; `tooltipLine` is that status's one tooltip line.
interface PluginStatus {
  kind: 'failedToLoad' | 'masterIssues' | 'unreadableRecords' | 'malformed';
  words: string;
  tooltipLine: string;
}

// The Malformed status's icon (ADR-0019's warning tier): a malformed plugin still loads and
// plays, unlike the other three, which are all `failurePrefixIcon()`'s error tier.
function malformedIcon(): vscode.ThemeIcon {
  return new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'));
}

function failedToLoadStatus(failure: string | undefined): PluginStatus | undefined {
  if (failure === undefined) return undefined;
  return { kind: 'failedToLoad', words: 'failed to load', tooltipLine: `Failed to load: ${failure}` };
}

function masterIssuesStatus(issues: MasterIssue[]): PluginStatus | undefined {
  if (issues.length === 0) return undefined;
  const reasons = issues.map((i) =>
    i.kind === 'DirectlyMissing' ? `Missing master: ${i.masterName}` : `Master ${i.masterName} cannot be loaded`);
  const words = issues.length === 1 ? '1 master issue' : `${issues.length} master issues`;
  return { kind: 'masterIssues', words, tooltipLine: `${words}: ${reasons.join('; ')}` };
}

function unreadableRecordsStatus(hasParseFailure: boolean): PluginStatus | undefined {
  if (!hasParseFailure) return undefined;
  return {
    kind: 'unreadableRecords', words: 'unreadable records',
    tooltipLine: 'This plugin holds a record that could not be read into its document.',
  };
}

// Nothing until mEdit answers: an unknown is neither tracked nor untracked, nor editable.
function factFlags(facts: PluginFacts | undefined): string[] {
  const flags: string[] = [];
  if (facts?.tracked !== undefined) flags.push(facts.tracked ? 'tracked' : 'untracked');
  if (facts?.readOnly === false) flags.push('editable');
  return flags;
}

function malformedStatus(diagnosisTexts: string[]): PluginStatus | undefined {
  if (diagnosisTexts.length === 0) return undefined;
  return { kind: 'malformed', words: 'malformed', tooltipLine: `Malformed: ${diagnosisTexts.join('; ')}` };
}

/** The one Plugins tree (ADR-0017). Rows are plugins.txt's lines, read from the Instance; their
 *  children are the record browser's; every badge comes from facts pulled once per reconcile. */
export class PluginsTreeProvider
  implements vscode.TreeDataProvider<PluginsTreeNode>, vscode.TreeDragAndDropController<PluginsTreeNode>, vscode.Disposable
{
  readonly dropMimeTypes = [DND_MIME] as const;
  readonly dragMimeTypes = [DND_MIME] as const;

  private readonly _onDidChangeTreeData = new vscode.EventEmitter<PluginsTreeNode | undefined | null>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly source: PluginListSource;
  private readonly log: (level: 'info' | 'warn' | 'error', msg: string) => void;
  private readonly reporter?: Reporter;
  private readonly dataFolderFile: (name: string) => string | undefined;
  private readonly implicitMasters: ImplicitMasterSource;
  private readonly instance: InstanceView;
  private readonly records?: RecordBrowser;
  private readonly client?: PluginFactsClient;
  private readonly publishDiagnoses?: (reports: PluginDiagnosisReport[]) => void;
  private instanceValue: InstanceValue;
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly firstRead: FirstRead;
  // The plugin rows' plugins.txt lines as last rendered, which a drop's order check reads: the
  // order the user dragged against.
  private lastOrder: { name: string; origin: string }[] = [];
  private filterText = '';
  private filterLower = '';
  private direction: SortDirection = 'losingAtTop';
  private recordFilterSource?: string;
  private recordFilterMatchesNothing = false;
  // Unfiltered rows, so a filter keystroke re-renders instead of re-walking the Instance value.
  // `invalidate()` clears it; `render()` leaves it intact.
  private cache?: { rows: PluginListNode[] };
  // Bumped by `invalidate()`, so a build that asked mEdit before it cannot cache over a newer one.
  private rowsGeneration = 0;
  // plugins.md, States, story 3: once mEdit names the locked plugins, an unreachable mEdit does not
  // unlock them.
  private lockedNames: readonly string[] | undefined;
  // Whether the last build had no row at all, which the message line says.
  private nothingToShow = false;
  private lastLockedRowUris: ReadonlySet<string> = new Set();

  constructor(options: PluginsTreeProviderOptions) {
    this.source = options.source;
    this.log = options.log ?? (() => {});
    this.reporter = options.reporter;
    this.dataFolderFile = options.dataFolderFile ?? NO_DATA_FOLDER_FILE;
    this.implicitMasters = options.implicitMasters ?? NO_IMPLICIT_MASTERS;
    this.instance = options.instance;
    this.records = options.records;
    this.client = options.client;
    this.publishDiagnoses = options.publishDiagnoses;
    this.instanceValue = options.instance.value;
    this.firstRead = firstReadOf(options.instance);
    this.subscriptions.push(this.firstRead, options.instance.subscribe((value) => {
      this.instanceValue = value;
      this.invalidate();
    }));
    if (options.records) {
      this.subscriptions.push(options.records.onDidChangeTreeData((child) => this._onDidChangeTreeData.fire(child)));
    }
    // plugins.md, The tree, story 2: the locked plugins are mEdit's answer, so an mEdit that
    // attaches after the rows were built rebuilds them.
    const unsubscribe = options.client?.onStatusChanged((status) => { if (status === 'attached') this.invalidate(); });
    if (unsubscribe) this.subscriptions.push({ dispose: unsubscribe });
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
    this._onDidChangeTreeData.dispose();
  }

  // ── rows ──────────────────────────────────────────────────────────────────

  // Re-pulls `instance.value` rather than trusting the copy the last subscriber callback left:
  // a caller forcing a resync (a failed write) gets whatever the Instance is
  // currently holding, not a snapshot that predates it.
  invalidate(): void {
    this.instanceValue = this.instance.value;
    this.cache = undefined;
    this.rowsGeneration++;
    this._onDidChangeTreeData.fire(undefined);
  }

  // A filter keystroke changes nothing on disk, so it must not force a re-render off a stale cache.
  private render(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  /** What the view's message line says about its rows: the game folder not found (common.md,
   *  States, story 5), else no rows at all (plugins.md, States, story 1), else a record filter
   *  that matches nothing (States, story 5). */
  viewMessage(): string | undefined {
    const { gameFolder } = this.instanceValue;
    if (this.instance.sequence !== 0 && gameFolder.kind !== 'found') {
      return `Game folder not found: set ${gameFolder.setting}. The Toolbox's Game row names each place Modbench looked.`;
    }
    if (this.nothingToShow) return NO_PLUGINS_MESSAGE;
    if (this.recordFilterSource !== undefined && this.matches !== undefined && this.recordFilterMatchesNothing) {
      return `No records match ${this.recordFilterSource}.`;
    }
    return undefined;
  }

  /** The source of the record filter in force, which the no-match message names; undefined while
   *  none is. */
  setRecordFilterSource(source: string | undefined): void {
    this.recordFilterSource = source;
    this.render();
  }

  /** Render-only, like the name filter: the rows, and so their expansion, survive a flip. */
  setViewDirection(direction: SortDirection): void {
    this.direction = direction;
    this.render();
  }

  /** Case-insensitive substring on plugin name; an empty string clears it. Render-only, so the
   *  cache survives. */
  setFilter(text: string): void {
    this.filterText = text;
    this.filterLower = text.toLowerCase();
    this.render();
  }

  /** A plugin row's winning plugin, as the Instance value resolved it, or a locked row's copy in
   *  the game folder (plugins.md, Menus and keys). `Promise`-wrapped only to keep the caller's
   *  `await` unchanged. */
  resolvePluginPath(row: PluginNode | ImplicitMasterNode): Promise<string | undefined> {
    if (row.kind === 'implicitMaster') return Promise.resolve(this.dataFolderFile(row.name));
    const folded = row.plugin.name.toLowerCase();
    return Promise.resolve(this.instanceValue.plugins.find((p) => p.winning && p.name.toLowerCase() === folded)?.path);
  }

  // The copy the game loads: the one the Mod override order resolves the name to, else the game
  // folder's.
  private lockedOriginOf(name: string): string {
    const folded = name.toLowerCase();
    return this.instanceValue.plugins.find((p) => p.winning && p.name.toLowerCase() === folded)?.origin ?? DATA_DIRECTORY_ORIGIN;
  }

  /** Lowercased, and empty before the first render. A live read, not a snapshot. */
  lockedRowUris(): ReadonlySet<string> {
    return this.lastLockedRowUris;
  }

  async getChildren(element?: PluginsTreeNode): Promise<PluginsTreeNode[]> {
    if (element === undefined) return this.rows();
    if (!isRow(element)) return this.identified(await (this.records?.getChildren(element) ?? []), this.pluginAbove.get(element));
    const file = pluginFileOf(element);
    return this.identified(await this.expandPluginRow(element, file), { name: file, origin: element.origin });
  }

  // The plugin row each row beneath it sits under: a record row's identity names that plugin.
  private readonly pluginAbove = new WeakMap<PluginsTreeNode, PluginAddress>();

  private identified(children: PluginsTreeNode[], plugin: PluginAddress | undefined): PluginsTreeNode[] {
    if (plugin === undefined) return children;
    for (const child of children) {
      this.pluginAbove.set(child, plugin);
      const formKey = recordFormKeyOf(child);
      if (formKey !== undefined) child.id = rowIdentity(child.kind, plugin, formKey);
    }
    return children;
  }

  // plugins.md, States 2-4: what a plugin row expands into, in precedence order.
  private async expandPluginRow(element: PluginListNode, file: string): Promise<PluginsTreeNode[]> {
    if (this.expansionOverride?.scope === 'everyRow') return [new ErrorNode(this.expansionOverride.message)];
    if (this.heldFiles?.has(file.toLowerCase()) === true) {
      // Deliberately not the row's own `origin`: a stated origin means "the plugin the load order
      // does not name" downstream, which would make every record row read-only. The backend
      // resolves a load-order filename itself.
      return this.records?.getPluginChildren(file, undefined, this.conditionsOf(element, file)) ?? noRecordBrowser();
    }
    // ADR-0002: never an empty list — that would read as "no records" (ADR-0019).
    const failure = this.reachableFailureOf(element);
    if (failure !== undefined) return [new ErrorNode(failure)];
    if (this.expansionOverride?.scope === 'unheldRow') return [new ErrorNode(this.expansionOverride.message)];
    return [new IndexingNode()];
  }

  private async rows(): Promise<(PluginListNode | ErrorNode)[]> {
    await this.firstRead.settled; // never claim "No plugins" before the Instance has actually read one
    if (this.firstRead.failure !== undefined) return [new ErrorNode(this.firstRead.failure)];

    const losingFirst = await this.builtRows();
    const built = this.direction === 'winningAtTop' ? [...losingFirst].reverse() : losingFirst;
    const named = this.filterText
      ? built.filter((n) => pluginFileOf(n).toLowerCase().includes(this.filterLower))
      : built;
    // plugins.md: a row the record filter matches nothing of is omitted, not merely left
    // unexpandable — a visible-but-inert row is still noise.
    return named.filter((row) => !this.isHiddenByFilter(row));
  }

  private async builtRows(): Promise<PluginListNode[]> {
    while (!this.cache) {
      const generation = this.rowsGeneration;
      this.settleRows(generation, await this.implicitMasters());
    }
    return this.cache.rows;
  }

  // A build that asked mEdit before the rows were last invalidated drops out.
  private settleRows(generation: number, lockedAnswer: readonly string[] | undefined): void {
    if (generation !== this.rowsGeneration) return;
    const rows = this.buildRows(lockedAnswer);
    this.cache = { rows };
    if ((rows.length === 0) !== this.nothingToShow) {
      this.nothingToShow = rows.length === 0;
      this.render(); // the message line reads it
    }
  }

  private buildRows(lockedAnswer: readonly string[] | undefined): PluginListNode[] {
    // Until mEdit names the locked plugins, a plugins.txt line for one of them renders as an
    // ordinary row, which is what the file says, rather than a guessed lock.
    this.lockedNames = lockedAnswer ?? this.lockedNames;
    const implicitNames = this.lockedNames ?? [];
    const implicitLower = new Set(implicitNames.map((n) => n.toLowerCase()));

    // One entry per plugins.txt line: the winning plugin of every listed name, in file order
    // (ADR-0013) — an overridden plugin of the same name carries the same slot and is excluded.
    const listed = this.instanceValue.plugins
      .filter((p): p is (typeof this.instanceValue.plugins)[number] & { slot: number } => p.slot !== null && p.winning)
      .sort((a, b) => a.slot - b.slot);

    // A name in both sets renders once, as the implicit row: the game loads it first, wherever its
    // line sits. A name on two lines renders once, at its first.
    const shown = new Set(implicitLower);
    const dedupedOrder = listed.filter((p) => {
      const folded = p.name.toLowerCase();
      if (shown.has(folded)) return false;
      shown.add(folded);
      return true;
    });
    this.lastOrder = dedupedOrder.map(({ name, origin }) => ({ name, origin }));
    const lockedRows = implicitNames.map((name) => new ImplicitMasterNode(name, this.lockedOriginOf(name), this.dataFolderFile(name)));
    this.lastLockedRowUris = new Set(lockedRows.flatMap((row) => (row.resourceUri ? [row.resourceUri.toString()] : [])));
    return [
      ...lockedRows,
      ...dedupedOrder.map((p) => new PluginNode({ name: p.name, enabled: p.enabled }, p.origin)),
    ];
  }

  // ── the tree item ─────────────────────────────────────────────────────────

  getTreeItem(element: PluginsTreeNode): vscode.TreeItem {
    if (!isRow(element)) return this.records?.getTreeItem(element) ?? element;
    element.collapsibleState = this.collapsibleStateOf(element);
    // A row is returned *as* its own TreeItem, so decorating in place would accumulate
    // permanently, with no way back once the condition clears.
    const base = this.captureOriginalDecoration(element);
    element.description = base.description;
    element.iconPath = base.iconPath;

    // ImplicitMasterNode keeps its constructor's decoration untouched: the locked
    // row's tooltip is MO2's one sentence alone (plugins.md, A plugin the game loads with no line).
    if (element.kind === 'plugin') this.decoratePlugin(element);
    return element;
  }

  // plugins.md, A row story 5: a disabled plugin's records are not the game's to load, so there
  // is nothing behind the row to expand into.
  private collapsibleStateOf(element: PluginListNode): vscode.TreeItemCollapsibleState {
    if (element.kind === 'plugin' && !element.plugin.enabled) return vscode.TreeItemCollapsibleState.None;
    return vscode.TreeItemCollapsibleState.Collapsed;
  }

  private readonly originalDecoration = new WeakMap<object, RowDecoration>();

  private captureOriginalDecoration(item: vscode.TreeItem): RowDecoration {
    const existing = this.originalDecoration.get(item);
    if (existing) return existing;
    const captured: RowDecoration = { description: item.description, iconPath: item.iconPath };
    this.originalDecoration.set(item, captured);
    return captured;
  }

  // plugins.md, A row: the tooltip always carries the file name and mod; description and icon
  // stay unset when no status applies.
  private decoratePlugin(row: PluginNode): void {
    const file = row.plugin.name;
    const joinedOrigin = this.joinOrigin(file, row);
    const statuses = this.statusesOf(row, joinedOrigin);
    const [first] = statuses;
    if (first !== undefined) {
      row.iconPath = first.kind === 'malformed' ? malformedIcon() : failurePrefixIcon();
      row.description = statuses.map((s) => s.words).join(', ');
    }
    const lines = [file, row.origin];
    if (this.facts?.get(file, joinedOrigin)?.readOnly === true) lines.push('read-only');
    for (const status of statuses) lines.push(status.tooltipLine);
    row.tooltip = lines.join('\n');
    row.contextValue = this.contextValueOf(row, joinedOrigin);
  }

  // plugins.md, Menus and keys: what every plugin menu condition reads. Where the plugin lives and
  // whether its line is enabled are the instance value's; tracked and editable wait on mEdit.
  private contextValueOf(row: PluginNode, joinedOrigin: string | undefined): string {
    const place = this.placeOf(row.origin);
    const facts = joinedOrigin === undefined ? undefined : this.facts?.get(row.plugin.name, joinedOrigin);
    return ['plugin', row.plugin.enabled ? 'enabled' : 'disabled', ...(place === undefined ? [] : [place]), ...factFlags(facts)]
      .join(' ');
  }

  // What the rows beneath a plugin row state about it: its tracked and editable flags.
  private conditionsOf(row: PluginListNode, file: string): PluginConditions {
    const joinedOrigin = this.joinOrigin(file, row);
    const facts = row.kind === 'plugin' && joinedOrigin === undefined ? undefined : this.facts?.get(file, joinedOrigin);
    return { tracked: facts?.tracked === true, editable: facts?.readOnly === false };
  }

  // The instance value names each mod's folder, whatever the mod manager calls the others.
  private placeOf(origin: string): 'inMod' | 'inOverwrite' | undefined {
    if (origin === OVERWRITE_ORIGIN) return 'inOverwrite';
    const folded = origin.toLowerCase();
    return [...this.instanceValue.paths.modDirs.keys()].some((mod) => mod.toLowerCase() === folded) ? 'inMod' : undefined;
  }

  /** Whether compile applies to any plugin, which compile's palette entry reads. */
  anyCompilable(): boolean {
    return this.someCompilable;
  }

  // plugins.md, Menus and keys, story 6: compile on a tracked, editable plugin.
  private compilable(file: string, origin: string): boolean {
    const facts = this.facts?.get(file, origin);
    return facts?.tracked === true && facts.readOnly !== true;
  }

  // plugins.md, A row: every status the plugin carries, spec order. `row.origin` joins load
  // failures; `joinedOrigin` joins every other fact.
  private statusesOf(row: PluginNode, joinedOrigin: string | undefined): PluginStatus[] {
    const file = row.plugin.name;
    const facts = this.facts?.get(file, joinedOrigin);
    const statuses = [
      failedToLoadStatus(this.loadFailures.get(file, row.origin)),
      masterIssuesStatus(facts?.masterIssues ?? []),
      unreadableRecordsStatus(facts?.parseFailure === true),
      malformedStatus(this.diagnoses?.get(file, joinedOrigin) ?? []),
    ];
    return statuses.filter((s): s is PluginStatus => s !== undefined);
  }

  // ── the load order and its facts ──────────────────────────────────────────

  private heldFiles?: Set<string>;
  private facts?: ByPluginAddress<PluginFacts>;
  private someCompilable = false;
  private matches?: ByPluginAddress<boolean>;
  private diagnoses?: ByPluginAddress<string[]>;
  // Row status only (plugins.md, A row: "no blink") — merges across a reload's ticks and
  // persists until `applyReconciled` lands the new answer.
  private loadFailures = new ByPluginAddress<string>();
  // Children expansion only (plugins.md, States 2) — this reload's own ticks, replaced wholesale
  // each time: a plugin not yet reached this reload reads as "still indexing", never a stale
  // failure from before the reload began.
  private reachableFailures = new ByPluginAddress<string>();
  // plugins.md, States 3-4: what an unheld row shows in place of "Still indexing…", and whether
  // that reaches even an already-held row. One field, so the two never disagree on precedence.
  private expansionOverride?: ExpansionOverride;
  // Bumped by every state-changing call this provider receives, so a slow read answering after a
  // newer one — or after teardown — cannot resurrect a stale answer.
  private generation = 0;

  /** A progressive reconcile's tick: a row's children resolve as its plugin lands. Row status
   *  stays as the last reconcile left it until `applyReconciled` lands; expansion tracks only
   *  this reload's own ticks. */
  applyIndexed(indexedPlugins: string[], failures: PluginLoadFailure[]): void {
    this.generation++;
    this.expansionOverride = undefined;
    this.heldFiles = new Set(indexedPlugins.map((n) => n.toLowerCase()));
    this.reachableFailures = indexLoadFailures(failures);
    mergeLoadFailures(this.loadFailures, failures);
    this._onDidChangeTreeData.fire(undefined);
  }

  /** ADR-0009 point 5; plugins.md, States 4: the load order's own refusal. `heldElsewhere`
   *  overrides every row; `failed` only a row this reload never reached. */
  applyRefused(refusal: LoadOrderRefusal): void {
    this.generation++;
    this.expansionOverride = { scope: refusal.kind === 'heldElsewhere' ? 'everyRow' : 'unheldRow', message: refusal.message };
    this._onDidChangeTreeData.fire(undefined);
  }

  /** ADR-0002 invariant 2; plugins.md, States 3: mEdit confirmed unreachable — the status bar's
   *  own Disconnected/Stopped, not Connecting. Named on a row not yet held; never downgrades an
   *  `everyRow` refusal already in force. */
  applyBackendUnreachable(reason: string): void {
    this.generation++;
    if (this.expansionOverride?.scope !== 'everyRow') this.expansionOverride = { scope: 'unheldRow', message: reason };
    this._onDidChangeTreeData.fire(undefined);
  }

  /** The completed reconcile's whole hand-off, in one read: which files the backend holds, and
   *  every fact it answers about each plugin. Returns what the record filter matched;
   *  `undefined` when the read failed. */
  async applyReconciled(failures: PluginLoadFailure[]): Promise<PluginMatch[] | undefined> {
    const generation = ++this.generation;
    const plugins = await this.readPlugins();
    if (plugins === undefined || generation !== this.generation) return undefined;
    this.expansionOverride = undefined;
    this.heldFiles = new Set(plugins.map((p) => p.name.toLowerCase()));
    this.loadFailures = indexLoadFailures(failures);
    this.reachableFailures = this.loadFailures;
    this.applyPluginFacts(plugins);
    // The record rows' own two contextValue axes, from this same read. A `.git` appearing or
    // vanishing under `mods/` is a watcher event, and that is a reconcile.
    this.records?.setImmutablePlugins(plugins.filter((p) => p.isImmutable).map(({ name, origin }) => ({ name, origin })));
    this.records?.setTrackedPlugins(plugins.filter((p) => p.isTracked).map(({ name, origin }) => ({ name, origin })));
    // Diagnoses stay as the last scan left them (no blink) until `scanDiagnoses` below lands a
    // fresh answer; a failed scan leaves them alone too.
    this._onDidChangeTreeData.fire(undefined);
    // Fire-and-forget (ADR-0019 background tier): the tree hand-off must not wait on a
    // whole-load-order scan, and a blip retries at the next reconcile.
    void this.scanDiagnoses(generation);
    return plugins.map((p) => ({ name: p.name, hasMatchingRecords: p.hasMatchingRecords }));
  }

  /** Re-reads the facts alone, leaving the held load order as it is — what a record edit or a
   *  filter change makes stale. `undefined` when the read failed. Bumps its own generation so a
   *  later refresh always wins. */
  async refreshFacts(): Promise<PluginMatch[] | undefined> {
    const generation = ++this.generation;
    const plugins = await this.readPlugins();
    if (plugins === undefined || generation !== this.generation) return undefined;
    this.applyPluginFacts(plugins);
    this._onDidChangeTreeData.fire(undefined);
    return plugins.map((p) => ({ name: p.name, hasMatchingRecords: p.hasMatchingRecords }));
  }

  // ADR-0013: keyed by filename, reading the `inLoadOrder` plugins — two held plugins can share
  // one. A failed read is never swallowed into an empty list, which would read as "nothing held".
  private async readPlugins(): Promise<PluginMetadata[] | undefined> {
    if (!this.client) return undefined;
    try {
      return (await this.client.getPlugins()).filter((p) => p.inLoadOrder);
    } catch (err) {
      const message = errorMessage(err);
      this.log('error', `[PluginsTreeProvider] reading the backend's plugin list failed: ${message}`);
      // A second window's refusal is not this read's to downgrade.
      if (this.expansionOverride?.scope !== 'everyRow') this.expansionOverride = { scope: 'unheldRow', message };
      // Briefly over-showing rows beats freezing every one behind a stale filter answer.
      this.matches = undefined;
      this._onDidChangeTreeData.fire(undefined);
      return undefined;
    }
  }

  // ADR-0017: `masterIssues` is a required, non-nullable array on the wire, so it is read straight
  // through — a `??` default would compensate for nothing the backend can do.
  private applyPluginFacts(plugins: PluginMetadata[]): void {
    const facts = new ByPluginAddress<PluginFacts>();
    const matches = new ByPluginAddress<boolean>();
    for (const p of plugins) {
      facts.set(p.name, p.origin, {
        readOnly: p.isImmutable, tracked: p.isTracked, masterIssues: p.masterIssues, parseFailure: p.hasParseFailure,
        order: { masters: p.masters, blueprint: p.isBlueprint },
      });
      matches.set(p.name, p.origin, p.hasMatchingRecords);
    }
    this.facts = facts;
    this.someCompilable = plugins.some((p) => this.compilable(p.name, p.origin));
    this.matches = matches;
    this.recordFilterMatchesNothing = plugins.length > 0 && plugins.every((p) => !p.hasMatchingRecords);
  }

  private async scanDiagnoses(generation: number): Promise<void> {
    if (!this.client) return;
    try {
      const reports = await this.client.getDiagnoses();
      if (generation !== this.generation) return;
      // One derivation, two surfaces — the tree badge and the Problems panel cannot disagree.
      this.publishDiagnoses?.(reports);
      const diagnoses = new ByPluginAddress<string[]>();
      for (const r of reports) diagnoses.append(r.plugin, r.origin, r.text);
      this.diagnoses = diagnoses;
      this._onDidChangeTreeData.fire(undefined);
    } catch (err) {
      this.log('warn', `[PluginsTreeProvider] the malformed-plugin scan could not be read: ${errorMessage(err)}`);
    }
  }

  // `hasMatchingRecords` only ever answers `false` while a filter is active, so no separate
  // "is a filter active" signal has to be threaded in here.
  private isHiddenByFilter(row: PluginListNode): boolean {
    const file = pluginFileOf(row);
    return this.matches?.get(file, this.joinOrigin(file, row)) === false;
  }

  // Children expansion only (plugins.md, States 2): this reload's own ticks, joined on the
  // row's own origin rather than through `joinOrigin`, as a failed plugin is never a held one.
  private reachableFailureOf(row: PluginListNode): string | undefined {
    const file = pluginFileOf(row);
    return this.reachableFailures.get(file, row.kind === 'plugin' ? row.origin : undefined);
  }

  // ADR-0012 keys every fact by origin. An implicit master has no mod origin to key on, so a row
  // the client's answer names no plugin for falls back to the filename.
  private joinOrigin(file: string, row: PluginListNode): string | undefined {
    return this.heldOrigin(file, row.kind === 'plugin' ? row.origin : undefined);
  }

  private heldOrigin(file: string, origin: string | undefined): string | undefined {
    return origin !== undefined && this.facts?.has(file, origin) === true ? origin : undefined;
  }

  // ── drag and drop ─────────────────────────────────────────────────────────

  /** VS Code passes the whole selection when the grabbed row is part of it, so `source` is the
   *  full block to move. Non-plugin rows cannot move. */
  handleDrag(
    source: readonly PluginsTreeNode[],
    dataTransfer: vscode.DataTransfer,
    _token: vscode.CancellationToken,
  ): void {
    const names = source.filter((n): n is PluginNode => n instanceof PluginNode).map((n) => n.plugin.name);
    if (names.length === 0) return;
    dataTransfer.set(DND_MIME, new vscode.DataTransferItem({ names }));
  }

  /** The order check reads the same drop the write applies to plugins.txt's order, whichever end
   *  the view shows at the top. */
  async handleDrop(
    target: PluginsTreeNode | undefined,
    dataTransfer: vscode.DataTransfer,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    const payload = dataTransfer.get(DND_MIME);
    if (!payload || !isDropPayload(payload.value)) return;
    const { names } = payload.value;
    const drop = this.dropFor(target, names);
    if (drop === undefined) return;
    const refusal = moveOrderRefusal(this.lastOrder.map((line) => line.name), names, drop, this.orderFacts());
    if (refusal !== undefined) {
      this.reporter?.report('error', 'Could not move plugins.', refusal);
      return;
    }
    try {
      await this.source.reorderPlugins(names, drop);
    } catch (e) {
      this.log('info', `[PluginsTreeProvider] reorderPlugins failed: ${errorMessage(e)}`);
      this.reporter?.report('error', 'Failed to move plugins.', errorMessage(e));
    }
  }

  // ADR-0012 invariant 1: only the line's own plugin, by its origin; another plugin of the name
  // is not it.
  private orderFacts(): PluginOrderFactsOf {
    const originOf = new Map(this.lastOrder.map((line) => [line.name, line.origin] as const));
    return (name) => {
      const origin = this.heldOrigin(name, originOf.get(name));
      return origin === undefined ? undefined : this.facts?.get(name, origin)?.order;
    };
  }

  // plugins.md, Drag and drop, story 2: a drop lands as shown in either direction, and the locked
  // rows load before every line. A row this controller never produced is not "past the last row".
  private dropFor(target: PluginsTreeNode | undefined, names: readonly string[]): PluginsDrop | undefined {
    if (names.length === 0) return undefined;
    if (target !== undefined && !OWN_ROW_KINDS.has((target as { kind?: string }).kind ?? '')) return undefined;
    const losingAtTop = this.direction === 'losingAtTop';
    if (target instanceof ImplicitMasterNode) return LOSING_END;
    if (target instanceof PluginNode) {
      if (names.includes(target.plugin.name)) return undefined;
      return { kind: losingAtTop ? 'before' : 'after', name: target.plugin.name };
    }
    return losingAtTop ? WINNING_END : LOSING_END;
  }
}

// VS Code only ever passes back an element `getChildren` returned, and only these two classes
// stand for a plugins.txt line.
function isRow(element: PluginsTreeNode): element is PluginListNode {
  return element instanceof PluginNode || element instanceof ImplicitMasterNode;
}

// plugins.md, Menus and keys: a record row is every row a record menu sits on.
function recordFormKeyOf(row: PluginsTreeNode): string | undefined {
  if (row.kind === 'record') return row.record.formKey;
  if (row.kind === 'worldspace' || row.kind === 'cell' || row.kind === 'placed') return row.formKey;
  return undefined;
}

function indexLoadFailures(failures: PluginLoadFailure[]): ByPluginAddress<string> {
  const byAddress = new ByPluginAddress<string>();
  mergeLoadFailures(byAddress, failures);
  return byAddress;
}

function mergeLoadFailures(target: ByPluginAddress<string>, failures: PluginLoadFailure[]): void {
  for (const f of failures) target.set(f.name, f.origin, f.reason);
}


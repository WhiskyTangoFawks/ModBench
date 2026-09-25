import * as vscode from 'vscode';
import { join } from 'node:path';
import type {
  MasterIssue, PluginDiagnosisReport, PluginLoadFailure, PluginMetadata, MEditClient, LoadOrderRefusal,
} from '../client';
import type { InstanceValue, InstanceView, PluginEntry } from '../instanceLoader/instance';
import { firstReadOf, type FirstRead } from './instanceFirstRead';
import type { Reporter } from '../ports/reporter';
import type { ImplicitMasterSource, PluginsDrop } from '../pluginsCommands/plugins';
import { failurePrefixIcon } from './failurePrefixIcon';
import { lockedRowUri } from './ImplicitMasterDecorationProvider';
import { IndexingNode, type PluginTreeNode, type PluginTreeProvider } from './PluginTreeProvider';
import { ErrorNode } from './errorNode';
import { errorMessage } from '../ports/errorMessage';

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
const NO_DATA_FOLDER: () => Promise<string | undefined> = () => Promise.resolve(undefined);
const NO_IMPLICIT_MASTERS: ImplicitMasterSource = () => Promise.resolve([]);

/** `reorderPlugins`, bound to the instance root and the active profile by the composition root;
 *  a refused command reaches this provider as a rejection. Enable/disable reaches its own core
 *  directly, never through the tree. */
export interface PluginListSource {
  reorderPlugins(pluginNames: string[], drop: PluginsDrop): Promise<void>;
}

/** The mEdit reads every plugin-keyed fact comes from — the port narrowed to what this tree
 *  calls. Pulled once per reconcile, never per rendered row. */
export type PluginFactsClient = Pick<MEditClient, 'getPlugins' | 'getDiagnoses'>;

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

/** `dataFolder` is a getter, not a settled `Promise`: the setting it resolves is editable while
 *  Modbench runs, so a value captured at construction could go stale for the provider's life. */
export interface PluginsTreeProviderOptions {
  /** Name, origin, slot, enabled and winning for every plugin copy — the row input (ADR-0015). */
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
  dataFolder?: () => Promise<string | undefined>;
  /** The rows the game forces on, which only the backend can name (ADR-0016). `undefined` — it
   *  could not be reached — renders no implicit row rather than a guessed one. */
  implicitMasters?: ImplicitMasterSource;
}

/** No `resourceUri`: VS Code infers a base icon from one unless `iconPath` overrides it, so
 *  setting one would silently change every row's icon. Losing copies are registered
 *  (ADR-0013), not displayed. */
export class PluginNode extends vscode.TreeItem {
  readonly kind = 'plugin' as const;
  constructor(
    public readonly plugin: PluginEntry,
    /** ADR-0012: which copy of the name this row stands for — the join key for every fact. */
    public readonly origin?: string,
  ) {
    super(plugin.name, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'plugin';
    // xEdit parity: selecting a plugin node shows its File Header, with no separate affordance.
    this.command = { command: 'modbench.openHeader', title: 'Open Header', arguments: [this] };
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
  constructor(public readonly name: string, path?: string) {
    super(name, vscode.TreeItemCollapsibleState.None);
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

export class EmptyNode extends vscode.TreeItem {
  readonly kind = 'empty' as const;
  constructor() {
    super('No plugins', vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon('check');
  }
}

export type PluginListNode = PluginNode | ImplicitMasterNode | EmptyNode;

// Each constructor above passes its own plain string to `super()` as the label, so this reads
// the same string back through its own field rather than the base class's string|TreeItemLabel.
function plainLabelOf(node: PluginListNode): string {
  switch (node.kind) {
    case 'plugin': return node.plugin.name;
    case 'implicitMaster': return node.name;
    case 'empty': return '';
  }
}

/** What this tree hands VS Code: a load-order row, or one of the record browser's nodes under
 *  it. */
export type PluginsTreeNode = PluginListNode | PluginTreeNode;

// The view is shared, so a drop must be able to tell these rows from another provider's.
const OWN_ROW_KINDS = new Set<string>(['plugin', 'implicitMaster', 'empty']);

/** The plugin file a row stands for, undefined for the empty-state row. */
export function pluginFileOf(node: PluginListNode): string | undefined {
  if (node.kind === 'plugin') return node.plugin.name;
  if (node.kind === 'implicitMaster') return node.name;
  return undefined;
}

// Everything one `GET /plugins` read knows about one plugin copy. One value rather than three
// parallel collections: they arrive together, change together, and are keyed the same way.
interface PluginFacts {
  readOnly?: boolean;
  masterIssues?: MasterIssue[];
  // Whether this plugin holds a record that could not be read into its document.
  parseFailure?: boolean;
}

// ADR-0012: plugin identity is origin plus filename, so every fact is filed under both.
class ByPluginCopy<T> {
  private readonly byCopy = new Map<string, T>();
  private readonly byName = new Map<string, T>();

  private static key(name: string, origin: string | undefined): string {
    return `${(origin ?? '').toLowerCase()}|${name.toLowerCase()}`;
  }

  set(name: string, origin: string | undefined, value: T): void {
    this.byCopy.set(ByPluginCopy.key(name, origin), value);
    this.byName.set(name.toLowerCase(), value);
  }

  // Each index accumulates on its own: the name-only fallback reads as every copy's lines
  // together, a copy's own key as its own. `this` narrows to an array-valued instance.
  append<U>(this: ByPluginCopy<U[]>, name: string, origin: string | undefined, item: U): void {
    const copyKey = ByPluginCopy.key(name, origin);
    const nameKey = name.toLowerCase();
    this.byCopy.set(copyKey, [...(this.byCopy.get(copyKey) ?? []), item]);
    this.byName.set(nameKey, [...(this.byName.get(nameKey) ?? []), item]);
  }

  get(name: string, origin: string | undefined): T | undefined {
    return origin === undefined
      ? this.byName.get(name.toLowerCase())
      : this.byCopy.get(ByPluginCopy.key(name, origin));
  }

  has(name: string, origin: string): boolean {
    return this.byCopy.has(ByPluginCopy.key(name, origin));
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
  private readonly dataFolder: () => Promise<string | undefined>;
  private readonly implicitMasters: ImplicitMasterSource;
  private readonly instance: InstanceView;
  private readonly records?: RecordBrowser;
  private readonly client?: PluginFactsClient;
  private readonly publishDiagnoses?: (reports: PluginDiagnosisReport[]) => void;
  private instanceValue: InstanceValue;
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly firstRead: FirstRead;
  // plugins.txt's raw file order as last rendered, so a drop computes its index against what
  // the user dragged against rather than a fresh read an external edit could skew.
  private lastOrder: string[] = [];
  private filterText = '';
  private filterLower = '';
  private recordFilterSource?: string;
  private recordFilterMatchesNothing = false;
  // Unfiltered rows, so a filter keystroke re-renders instead of re-walking the Instance value.
  // `invalidate()` clears it; `render()` leaves it intact.
  private cache?: { rows: PluginListNode[] };
  private lastImplicitNames: ReadonlySet<string> = new Set();

  constructor(options: PluginsTreeProviderOptions) {
    this.source = options.source;
    this.log = options.log ?? (() => {});
    this.reporter = options.reporter;
    this.dataFolder = options.dataFolder ?? NO_DATA_FOLDER;
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
    // Forwarded with the element intact, so a targeted refresh (a "Load more…" landing under one
    // record type) stays targeted.
    if (options.records) {
      this.subscriptions.push(options.records.onDidChangeTreeData((child) => this._onDidChangeTreeData.fire(child)));
    }
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
    this._onDidChangeTreeData.fire(undefined);
  }

  // A filter keystroke changes nothing on disk, so it must not force a re-render off a stale cache.
  private render(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  /** What the view's message line says about its rows: the game folder not found (common.md,
   *  States, story 5), else a record filter that matches nothing (plugins.md, States, story 5). */
  viewMessage(): string | undefined {
    const { gameFolder } = this.instanceValue;
    if (this.instance.sequence !== 0 && gameFolder.kind !== 'found') {
      return `Game folder not found: set ${gameFolder.setting}. The Toolbox's Game row names each place Modbench looked.`;
    }
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

  /** Case-insensitive substring on plugin name; an empty string clears it. Render-only, so the
   *  cache survives. */
  setFilter(text: string): void {
    this.filterText = text;
    this.filterLower = text.toLowerCase();
    this.render();
  }

  /** The winning copy's own path, already resolved on the Instance value — undefined for a name
   *  with no winning copy. A synchronous lookup, `Promise`-wrapped only to keep the caller's
   *  `await` unchanged. */
  resolvePluginPath(name: string): Promise<string | undefined> {
    const folded = name.toLowerCase();
    return Promise.resolve(this.instanceValue.plugins.find((p) => p.winning && p.name.toLowerCase() === folded)?.path);
  }

  /** Lowercased, and empty before the first render. A live read, not a snapshot. */
  implicitMasterNames(): ReadonlySet<string> {
    return this.lastImplicitNames;
  }

  async getChildren(element?: PluginsTreeNode): Promise<PluginsTreeNode[]> {
    if (element === undefined) return this.rows();
    if (!isRow(element)) return this.records?.getChildren(element) ?? [];
    const file = pluginFileOf(element);
    if (file === undefined) return []; // EmptyNode: no plugin to expand into
    return this.expandPluginRow(element, file);
  }

  // plugins.md, States 2-4: what a plugin row expands into, in precedence order.
  private async expandPluginRow(element: PluginListNode, file: string): Promise<PluginsTreeNode[]> {
    if (this.expansionOverride?.scope === 'everyRow') return [new ErrorNode(this.expansionOverride.message)];
    if (this.heldFiles?.has(file.toLowerCase()) === true) {
      // Deliberately not the row's own `origin`: a stated origin means "the copy the load order
      // does not name" downstream, which would make every record row read-only. The backend
      // resolves a load-order filename itself.
      return this.records?.getPluginChildren(file) ?? noRecordBrowser();
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

    if (!this.cache) {
      const built = await this.buildRows();
      if (built.kind === 'empty') return [new EmptyNode()];
      this.cache = built.cache;
    }

    const named = this.filterText
      ? this.cache.rows.filter((n) => plainLabelOf(n).toLowerCase().includes(this.filterLower))
      : this.cache.rows;
    // plugins.md: a row the record filter matches nothing of is omitted, not merely left
    // unexpandable — a visible-but-inert row is still noise.
    return named.filter((row) => !this.isHiddenByFilter(row));
  }

  private async buildRows(): Promise<
    | { kind: 'empty' }
    | { kind: 'ok'; cache: { rows: PluginListNode[] } }
  > {
    const dataFolder = await this.dataFolder();
    // An unreachable backend renders no implicit row: a plugins.txt line for one of them then
    // renders as an ordinary row, which is what the file says, rather than a guessed lock.
    const implicitNames = (await this.implicitMasters()) ?? [];
    const implicitLower = new Set(implicitNames.map((n) => n.toLowerCase()));

    // One entry per plugins.txt line: the winning copy of every listed name, in file order
    // (ADR-0013) — a losing copy of the same name carries the same slot and is excluded.
    const listed = this.instanceValue.plugins
      .filter((p): p is (typeof this.instanceValue.plugins)[number] & { slot: number } => p.slot !== null && p.winning)
      .sort((a, b) => a.slot - b.slot);
    this.lastOrder = listed.map((p) => p.name);

    // A name in both sets renders once, as the implicit row. Display order only:
    // `this.lastOrder` stays plugins.txt's raw order, which write positions are computed against.
    const dedupedOrder = listed.filter((p) => !implicitLower.has(p.name.toLowerCase()));
    if (implicitNames.length + dedupedOrder.length === 0) return { kind: 'empty' };

    this.lastImplicitNames = implicitLower;
    const rows: PluginListNode[] = [
      ...implicitNames.map((name) => new ImplicitMasterNode(name, dataFolder ? join(dataFolder, name) : undefined)),
      ...dedupedOrder.map((p) => new PluginNode({ name: p.name, enabled: p.enabled }, p.origin)),
    ];
    return { kind: 'ok', cache: { rows } };
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

    // ImplicitMasterNode and EmptyNode keep their constructor's decoration untouched: the locked
    // row's tooltip is MO2's one sentence alone (plugins.md, A plugin the game loads with no line).
    if (element.kind === 'plugin') this.decoratePlugin(element);
    return element;
  }

  // plugins.md, A row story 5: a disabled plugin's records are not the game's to load, so there
  // is nothing behind the row to expand into.
  private collapsibleStateOf(element: PluginListNode): vscode.TreeItemCollapsibleState {
    if (pluginFileOf(element) === undefined) return vscode.TreeItemCollapsibleState.None;
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
    const lines = [file];
    if (row.origin !== undefined) lines.push(row.origin);
    if (this.facts?.get(file, joinedOrigin)?.readOnly === true) lines.push('read-only');
    for (const status of statuses) lines.push(status.tooltipLine);
    row.tooltip = lines.join('\n');
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
  private facts?: ByPluginCopy<PluginFacts>;
  private matches?: ByPluginCopy<boolean>;
  private diagnoses?: ByPluginCopy<string[]>;
  // Row status only (plugins.md, A row: "no blink") — merges across a reload's ticks and
  // persists until `applyReconciled` lands the new answer.
  private loadFailures = new ByPluginCopy<string>();
  // Children expansion only (plugins.md, States 2) — this reload's own ticks, replaced wholesale
  // each time: a plugin not yet reached this reload reads as "still indexing", never a stale
  // failure from before the reload began.
  private reachableFailures = new ByPluginCopy<string>();
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
   *  every fact it answers about each copy. Returns what the record filter matched;
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

  // ADR-0013: keyed by filename, reading the `inLoadOrder` copies — two held copies can share
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
    const facts = new ByPluginCopy<PluginFacts>();
    const matches = new ByPluginCopy<boolean>();
    for (const p of plugins) {
      facts.set(p.name, p.origin, {
        readOnly: p.isImmutable, masterIssues: p.masterIssues, parseFailure: p.hasParseFailure,
      });
      matches.set(p.name, p.origin, p.hasMatchingRecords);
    }
    this.facts = facts;
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
      const diagnoses = new ByPluginCopy<string[]>();
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
    if (file === undefined) return false;
    return this.matches?.get(file, this.joinOrigin(file, row)) === false;
  }

  // Children expansion only (plugins.md, States 2): this reload's own ticks, joined on the
  // row's own origin rather than through `joinOrigin`, as a failed copy is never a held one.
  private reachableFailureOf(row: PluginListNode): string | undefined {
    const file = pluginFileOf(row);
    if (file === undefined) return undefined;
    return this.reachableFailures.get(file, row.kind === 'plugin' ? row.origin : undefined);
  }

  // ADR-0012 keys every fact by origin. An implicit master has no mod origin to key on, so a row
  // the client's answer names no copy for falls back to the filename.
  private joinOrigin(file: string, row: PluginListNode): string | undefined {
    const origin = row.kind === 'plugin' ? row.origin : undefined;
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

  /** The block lands before `target`, or at the end past the last row. A drop onto the implicit
   *  masters is no plugins.txt position — those rows have no line — so it lands at file
   *  index 0. */
  async handleDrop(
    target: PluginsTreeNode | undefined,
    dataTransfer: vscode.DataTransfer,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    const payload = dataTransfer.get(DND_MIME);
    if (!payload || !isDropPayload(payload.value)) return;
    const { names } = payload.value;
    if (names.length === 0) return;
    const drop = this.dropFor(target);
    if (drop === undefined) return;
    try {
      await this.source.reorderPlugins(names, drop);
    } catch (e) {
      // ADR-0019: an explicit user action failed — notify + log, then resync the
      // moved rows against disk so the tree never shows a phantom reorder.
      this.log('info', `[PluginsTreeProvider] reorderPlugins failed: ${errorMessage(e)}`);
      this.reporter?.report('error', 'Failed to reorder plugins.', errorMessage(e));
    }
    this.invalidate();
  }

  // VS Code can hand the drop a row this controller never produced, and "not one of my rows" is
  // not "past the last row" — the latter means the losing end, so a foreign row must not fall
  // through to it.
  private dropFor(target: PluginsTreeNode | undefined): PluginsDrop | undefined {
    if (target !== undefined && !OWN_ROW_KINDS.has((target as { kind?: string }).kind ?? '')) return undefined;
    // An implicit master's row is above every plugins.txt line, so a drop on one is the top.
    if (target instanceof ImplicitMasterNode) return { kind: 'winningEnd' };
    if (target instanceof PluginNode) return { kind: 'before', name: target.plugin.name };
    return { kind: 'losingEnd' };
  }
}

// VS Code only ever passes back an element `getChildren` returned, and only these three classes
// stand for a plugins.txt line.
function isRow(element: PluginsTreeNode): element is PluginListNode {
  return element instanceof PluginNode || element instanceof ImplicitMasterNode || element instanceof EmptyNode;
}

function indexLoadFailures(failures: PluginLoadFailure[]): ByPluginCopy<string> {
  const byCopy = new ByPluginCopy<string>();
  mergeLoadFailures(byCopy, failures);
  return byCopy;
}

function mergeLoadFailures(target: ByPluginCopy<string>, failures: PluginLoadFailure[]): void {
  for (const f of failures) target.set(f.name, f.origin, f.reason);
}


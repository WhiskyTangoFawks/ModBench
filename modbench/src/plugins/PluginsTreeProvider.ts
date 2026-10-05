import * as vscode from 'vscode';
import type {
  PluginDiagnosisReport, PluginLoadFailure, PluginMetadata, MEditClient, LoadOrderRefusal, PluginAddress, NotificationPayloads,
} from '../client';
import { lastGoodReadMessage, type Instance, type InstanceValue, type InstanceView, type PluginEntry } from '../instanceLoader/instance';
import type { SortDirection } from '../drivingLib/sortDirectionToggle';
import { firstReadOf, type FirstRead } from '../drivingLib/instanceFirstRead';
import type { Reporter } from '../ports/reporter';
import { headerFormKeyFor } from './formKeyIdentity';
import type { PluginsDrop } from '../pluginsCommands/plugins';
import { moveOrderRefusal, type PluginOrderFactsOf } from '../pluginsCommands/pluginOrder';
import { failurePrefixIcon } from './failurePrefixIcon';
import { lockedRowUri } from './ImplicitMasterDecorationProvider';
import { IndexingNode, type PluginTreeNode, type PluginTreeProvider } from './PluginTreeProvider';
import { ErrorNode } from '../drivingLib/errorNode';
import { pluginAddressKey, samePluginAddress } from '../wire/pluginAddress';
import { PluginFacts, placeOf, type PluginWarning } from './pluginFacts';
import { isRecordRow, PLUGINS_KEY_ARGS } from './gestureEntry';
import { runWritingGesture } from '../drivingLib/writingGesture';
import type { RecordGroup } from './createdRecordSelection';
import { errorMessage } from '../ports/errorMessage';
import { DATA_DIRECTORY_ORIGIN } from '../instanceLoader/loadOrderSnapshot';

export type PluginsInstance = InstanceView & Pick<Instance, 'refresh'>;

const DND_MIME = 'application/vnd.medit.pluginlist-node';

// One entry per plugins.txt line: the winning plugin of every listed name, in file order
// (plugins.md, The tree, stories 1 and 3). An overridden plugin carries the same slot and is
// excluded.
function listedPlugins(value: InstanceValue): (InstanceValue['plugins'][number] & { slot: number })[] {
  return value.plugins
    .filter((p): p is InstanceValue['plugins'][number] & { slot: number } => p.slot !== null && p.winning)
    .sort((a, b) => a.slot - b.slot);
}

// `DataTransferItem.value` is `any` — handleDrag, above `handleDrop` below, is this provider's
// only writer of it. Exported so a test narrows the same payload the same way, instead of a
// second cast of its own.
function isAddress(value: unknown): value is PluginAddress {
  return typeof value === 'object' && value !== null && 'name' in value && typeof value.name === 'string'
    && 'origin' in value && typeof value.origin === 'string';
}

export function isDropPayload(value: unknown): value is { plugins: PluginAddress[] } {
  return typeof value === 'object' && value !== null && 'plugins' in value && Array.isArray(value.plugins)
    && value.plugins.every(isAddress);
}

// toolbox.ts's composition root always wires a real RecordBrowser; reaching this means a test
// exercised rows with none.
const NO_RECORD_BROWSER = 'mEdit is not connected.';
const noRecordBrowser = (): [ErrorNode] => [new ErrorNode(NO_RECORD_BROWSER)];

// Hoisted out of the constructor so an omitted dependency is not a fresh closure per instance.
const NO_DATA_FOLDER_FILE = (): string | undefined => undefined;

/** `reorderPlugins`, bound to the instance and the active profile by the composition root;
 *  a refused command reaches this provider as a rejection. Enable/disable reaches its own core
 *  directly, never through the tree. */
export interface PluginListSource {
  reorderPlugins(pluginNames: string[], drop: PluginsDrop): Promise<void>;
}

/** The mEdit reads every plugin-keyed fact comes from — the port narrowed to what this tree
 *  calls. Pulled once per reconcile, never per rendered row; and its attaching, which makes the
 *  locked plugins askable. */
export type PluginFactsClient = Pick<MEditClient, 'getPlugins' | 'getDiagnoses' | 'onStatusChanged' | 'onNotification' | 'getRecordHolders'>;

/** The record browser a row's children are delegated to (ADR-0017). `PluginTreeProvider`
 *  satisfies it. */
export type RecordBrowser = Pick<
  PluginTreeProvider,
  'getPluginChildren' | 'getChildren' | 'getTreeItem' | 'onDidChangeTreeData'
>;

/** One held plugin as the record filter's own state reads it. The reconcile hands these back so
 *  the caller needs no second `GET /plugins` for the same answer. */
export interface PluginMatch {
  name: string;
  hasMatchingRecords: boolean;
}

export type { PluginWarning };

export interface PluginsTreeProviderOptions {
  /** Name, origin, slot, enabled and winning for every plugin: the row input. */
  instance: PluginsInstance;
  source: PluginListSource;
  /** A row's children. Absent in tests that exercise rows alone. */
  records?: RecordBrowser;
  /** Every plugin-keyed fact. Absent in tests that exercise rows alone. */
  client?: PluginFactsClient;
  /** The malformed-plugin scan's other surface, the Problems panel, which needs an instance root
   *  this provider has no business knowing. */
  publishDiagnoses?: (reports: PluginDiagnosisReport[]) => void;
  /** The Changed outside Modbench status's other surface, the Problems panel: a warning for every
   *  such plugin. */
  publishChangedOutside?: (warnings: readonly PluginWarning[]) => void;
  /** This provider states the severity (ADR-0019), so a background blip and a failed
   *  read land on different channel levels. */
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
  reporter?: Reporter;
  /** The Instance adapter's path of a file at the root of the Data folder, read fresh at each
   *  call: the game folder setting is editable while Modbench runs. `undefined` while the folder
   *  is not found. */
  dataFolderFile?: (name: string) => string | undefined;
}


// plugins.md, A row, Identity: VS Code keeps expansion and selection across a rebuild by it, and
// refuses two rows that share one.
function rowIdentity(kind: string, plugin: PluginAddress, formKey?: string): string {
  return [kind, pluginAddressKey(plugin), ...(formKey === undefined ? [] : [formKey])].join(':');
}

function openHeaderCommand(plugin: string, origin: string): vscode.Command {
  return { command: 'modbench.record.open', title: 'Open Record', arguments: [{ formKey: headerFormKeyFor(plugin), origin }] };
}

/** No `resourceUri`: VS Code infers a base icon from one unless `iconPath` overrides it, so
 *  setting one would silently change every row's icon. Overridden plugins:
 *  plugins.md, The tree, story 3. */
export class PluginNode extends vscode.TreeItem {
  readonly kind = 'plugin' as const;
  constructor(
    public readonly plugin: PluginEntry,
    /** Which plugin of the name this row stands for (ADR-0012), the join key for every fact. */
    public readonly origin: string,
  ) {
    super(plugin.name, vscode.TreeItemCollapsibleState.None);
    this.id = rowIdentity(this.kind, { name: plugin.name, origin });
    this.contextValue = `plugin ${plugin.enabled ? 'enabled' : 'disabled'}`;
    // xEdit parity: selecting a plugin node shows its File Header, with no separate affordance.
    // plugins.md, Menus and keys, story 2: the game loads no disabled plugin's records, so a click
    // on its row only selects it.
    if (plugin.enabled) this.command = openHeaderCommand(plugin.name, origin);
    this.checkboxState = plugin.enabled
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
  }
}

/** A lock stands in for the reference tool's checkbox (plugins.md, A plugin the game loads with
 *  no line). */
export class ImplicitMasterNode extends vscode.TreeItem {
  readonly kind = 'implicitMaster' as const;
  constructor(public readonly name: string, public readonly origin: string, path?: string) {
    super(name, vscode.TreeItemCollapsibleState.None);
    this.id = rowIdentity(this.kind, { name, origin });
    this.contextValue = 'pluginImplicit';
    this.iconPath = new vscode.ThemeIcon('lock');
    // plugins.md, A plugin the game loads with no line: the reference tool's one sentence alone —
    // the label already shows the greyed file name, so the tooltip does not repeat it.
    this.tooltip = "This plugin can't be disabled or moved (enforced by the game).";
    this.command = openHeaderCommand(name, origin);
    if (path !== undefined) this.resourceUri = lockedRowUri(path);
  }
}

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

function addressOfRow(node: PluginListNode): PluginAddress {
  return { name: pluginFileOf(node), origin: node.origin };
}

type RowDecoration = {
  description: vscode.TreeItem['description'];
  iconPath: vscode.TreeItem['iconPath'];
};

// The yellow status icon (plugins.md, A row).
function warningIcon(): vscode.ThemeIcon {
  return new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'));
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
  private readonly instance: PluginsInstance;
  private readonly records?: RecordBrowser;
  private readonly client?: PluginFactsClient;
  private readonly publishDiagnoses?: (reports: PluginDiagnosisReport[]) => void;
  private readonly publishChangedOutside?: (warnings: readonly PluginWarning[]) => void;
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
  private lastBuildHadNoRows = false;
  private lastLockedRowUris: ReadonlySet<string> = new Set();

  constructor(options: PluginsTreeProviderOptions) {
    this.source = options.source;
    this.log = options.log ?? (() => {});
    this.reporter = options.reporter;
    this.dataFolderFile = options.dataFolderFile ?? NO_DATA_FOLDER_FILE;
    this.instance = options.instance;
    this.records = options.records;
    this.client = options.client;
    this.publishDiagnoses = options.publishDiagnoses;
    this.publishChangedOutside = options.publishChangedOutside;
    this.instanceValue = options.instance.value;
    this.firstRead = firstReadOf(options.instance);
    this.subscriptions.push(this.firstRead, options.instance.subscribe((value) => {
      this.instanceValue = value;
      this.invalidate();
    }), options.instance.onReadFailure(() => this.render()));
    if (options.records) {
      this.subscriptions.push(options.records.onDidChangeTreeData((child) => this._onDidChangeTreeData.fire(child)));
    }
    const unsubscribeChanges = options.client?.onNotification('external-change', (change) => this.applyExternalChange(change));
    if (unsubscribeChanges) this.subscriptions.push({ dispose: unsubscribeChanges });
  }

  private applyExternalChange(event: NotificationPayloads['external-change']): void {
    this.facts.externalChange(event);
    this.publishChangedOutside?.(this.facts.problems().changedOutside);
    this._onDidChangeTreeData.fire(undefined);
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

  viewMessage(): string | undefined {
    return [this.firstHeldMessage(), this.lastGoodReadMessage()].filter((part) => part !== undefined).join(' ') || undefined;
  }

  lastGoodReadMessage(): string | undefined {
    return lastGoodReadMessage(this.instance);
  }

  private firstHeldMessage(): string | undefined {
    const { gameFolder } = this.instanceValue;
    return this.facts.heldMessage({
      gameFolderMessage: this.instance.sequence !== 0 && gameFolder.kind !== 'found'
        ? `Game folder not found: set ${gameFolder.setting}. The Toolbox's Game row names each place Modbench looked.`
        : undefined,
      noRowsMessage: this.lastBuildHadNoRows ? NO_PLUGINS_MESSAGE : undefined,
      recordFilterSource: this.recordFilterSource,
    });
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

  resolvePluginPath(row: PluginNode | ImplicitMasterNode): Promise<string | undefined> {
    return Promise.resolve(this.pluginFile(addressOfRow(row)));
  }

  /** The plugin's own file (ADR-0012), or the game folder's copy for a game-folder plugin the
   *  Instance value lists no file for. */
  pluginFile(address: PluginAddress): string | undefined {
    const listed = this.instanceValue.plugins.find((p) => samePluginAddress(p, address))?.path;
    return listed ?? (address.origin === DATA_DIRECTORY_ORIGIN ? this.dataFolderFile(address.name) : undefined);
  }

  /** Whether the row's line is enabled now: a row the view still holds may predate the value. */
  isEnabled(row: PluginNode): boolean {
    const address = addressOfRow(row);
    return this.instanceValue.plugins.some((p) => p.winning && p.enabled && samePluginAddress(p, address));
  }

  /** Lowercased, and empty before the first render. A live read, not a snapshot. */
  lockedRowUris(): ReadonlySet<string> {
    return this.lastLockedRowUris;
  }

  async getChildren(element?: PluginsTreeNode): Promise<PluginsTreeNode[]> {
    if (element === undefined) return this.rows();
    const children = isRow(element)
      ? await this.expandPluginRow(element, pluginFileOf(element))
      : await (this.records?.getChildren(element) ?? []);
    return this.adopted(children, element);
  }

  /** VS Code's walk up from a row it is asked to reveal. */
  getParent(element: PluginsTreeNode): PluginsTreeNode | undefined {
    return this.parentOf.get(element);
  }

  private readonly parentOf = new WeakMap<PluginsTreeNode, PluginsTreeNode>();

  private adopted(children: PluginsTreeNode[], parent: PluginsTreeNode): PluginsTreeNode[] {
    const plugin = this.pluginOf(parent);
    for (const child of children) {
      this.parentOf.set(child, parent);
      const formKey = recordFormKeyOf(child);
      if (formKey !== undefined && plugin !== undefined) child.id = rowIdentity(child.kind, plugin, formKey);
    }
    return children;
  }

  private pluginOf(node: PluginsTreeNode): PluginAddress | undefined {
    let current: PluginsTreeNode | undefined = node;
    while (current !== undefined && !isRow(current)) current = this.parentOf.get(current);
    return current && addressOfRow(current);
  }

  /** The row of a record, once mEdit lists it in its group. */
  async recordRow({ plugin, recordType }: RecordGroup, formKey: string): Promise<PluginsTreeNode | undefined> {
    const pluginRow = (await this.rows()).find((row) => row.kind === 'plugin' && samePluginAddress(addressOfRow(row), plugin));
    if (pluginRow === undefined) return undefined;
    const group = (await this.getChildren(pluginRow)).find((row) => row.kind === 'recordType' && row.recordType === recordType);
    if (group === undefined) return undefined;
    return (await this.getChildren(group)).find((row) => row.kind === 'record' && row.record.formKey === formKey);
  }

  private async expandPluginRow(element: PluginListNode, file: string): Promise<PluginsTreeNode[]> {
    const address = addressOfRow(element);
    const expansion = this.facts.expansion(address);
    if (expansion.kind === 'error') return [new ErrorNode(expansion.message)];
    if (expansion.kind === 'indexing') return [new IndexingNode()];
    return this.records?.getPluginChildren(file, element.origin, this.facts.conditions(address)) ?? noRecordBrowser();
  }

  private async rows(): Promise<(PluginListNode | ErrorNode)[]> {
    await this.firstRead.settled; // never claim "No plugins" before the Instance has actually read one
    if (this.firstRead.failure !== undefined) return [new ErrorNode(this.firstRead.failure)];

    const losingFirst = this.builtRows();
    const built = this.direction === 'winningAtTop' ? [...losingFirst].reverse() : losingFirst;
    const named = this.filterText
      ? built.filter((n) => pluginFileOf(n).toLowerCase().includes(this.filterLower))
      : built;
    // plugins.md: a row the record filter matches nothing of is omitted, not merely left
    // unexpandable — a visible-but-inert row is still noise.
    return named.filter((row) => !this.isHiddenByFilter(row));
  }

  private builtRows(): PluginListNode[] {
    if (!this.cache) {
      const rows = this.buildRows();
      this.cache = { rows };
      if ((rows.length === 0) !== this.lastBuildHadNoRows) {
        this.lastBuildHadNoRows = rows.length === 0;
        this.render();
      }
    }
    return this.cache.rows;
  }

  private buildRows(): PluginListNode[] {
    // While Mod Management cannot name the plugins the game loads with no line (ADR-0013), a
    // plugins.txt line for one renders as an ordinary row, which is what the file says.
    const loadedWithNoLine = this.instanceValue.pluginsLoadedWithNoLine ?? [];
    const implicitKeys = new Set(loadedWithNoLine.map(pluginAddressKey));

    const listed = listedPlugins(this.instanceValue);

    // A name in both sets renders once, as the implicit row: the game loads it first, wherever its
    // line sits. A name on two lines renders once, at its first.
    const shown = new Set(implicitKeys);
    const dedupedOrder = listed.filter((p) => {
      const key = pluginAddressKey(p);
      if (shown.has(key)) return false;
      shown.add(key);
      return true;
    });
    this.lastOrder = dedupedOrder.map(({ name, origin }) => ({ name, origin }));
    const lockedRows = loadedWithNoLine.map(({ name, origin }) => new ImplicitMasterNode(name, origin, this.dataFolderFile(name)));
    this.lastLockedRowUris = new Set(lockedRows.flatMap((row) => (row.resourceUri ? [row.resourceUri.toString()] : [])));
    return [
      ...lockedRows,
      ...dedupedOrder.map((p) => new PluginNode({
        name: p.name, enabled: p.enabled,
      }, p.origin)),
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

    // ImplicitMasterNode keeps its constructor's decoration untouched: the locked row's tooltip is
    // the reference tool's one sentence alone (plugins.md, A plugin the game loads with no line).
    if (element.kind === 'plugin') this.decoratePlugin(element);
    return element;
  }

  // plugins.md, The tree, story 4: a disabled plugin's records are not the game's to load, so there
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

  // plugins.md, A row: description and icon stay unset when no status applies.
  private decoratePlugin(row: PluginNode): void {
    const address = addressOfRow(row);
    const icon = this.facts.icon(address);
    if (icon !== undefined) {
      row.iconPath = icon === 'warning' ? warningIcon() : failurePrefixIcon();
      row.description = this.facts.description(address);
    }
    row.tooltip = this.facts.tooltipLines(address).join('\n');
    row.contextValue = this.contextValueOf(row, address);
  }

  // plugins.md, Menus and keys: what every plugin menu condition reads. Where the plugin lives and
  // whether its line is enabled are the instance value's; tracked and editable wait on mEdit.
  private contextValueOf(row: PluginNode, address: PluginAddress): string {
    const place = placeOf(row.origin, { modDirs: this.instanceValue.paths.modDirs, trackedMods: this.instanceValue.trackedMods });
    return ['plugin', row.plugin.enabled ? 'enabled' : 'disabled', ...(place === undefined ? [] : [place]), ...this.facts.contextFlags(address)]
      .join(' ');
  }

  /** Whether compile applies to any plugin, which compile's palette entry reads. */
  anyCompilable(): boolean {
    return this.facts.anyCompilable();
  }

  // ── the load order and its facts ──────────────────────────────────────────

  private readonly facts = new PluginFacts();
  // Bumped by each reconcile step (a tick, a refusal, unreachable, the hand-off), so a slow read
  // answering after a newer step cannot resurrect a stale answer.
  private generation = 0;
  // `refreshFacts`' own order, apart from `generation` so a fact re-read never discards a hand-off.
  private factsRead = 0;

  /** A progressive reconcile's tick: a row's children resolve as its plugin lands. Row status
   *  stays as the last reconcile left it until `applyReconciled` lands; expansion tracks only
   *  this reload's own ticks. */
  applyIndexed(indexedPlugins: PluginAddress[], failures: PluginLoadFailure[]): void {
    this.generation++;
    this.facts.indexed(indexedPlugins, failures);
    this._onDidChangeTreeData.fire(undefined);
  }

  /** The load order's own refusal (ADR-0010; plugins.md, States, stories 4 and 6). */
  applyRefused(refusal: LoadOrderRefusal): void {
    this.generation++;
    this.facts.refused(refusal);
    this._onDidChangeTreeData.fire(undefined);
  }

  /** mEdit confirmed unreachable (ADR-0002; plugins.md, States, story 3), as the status
   *  bar's Disconnected or Stopped says. Named on a row not yet held; never downgrades an
   *  `everyRow` refusal already in force. */
  applyBackendUnreachable(reason: string): void {
    this.generation++;
    this.facts.unreachable(reason);
    this._onDidChangeTreeData.fire(undefined);
  }

  /** The completed reconcile's whole hand-off, in one read: which files the backend holds, and
   *  every fact it answers about each plugin. Returns what the record filter matched;
   *  `undefined` when the read failed. */
  async applyReconciled(failures: PluginLoadFailure[]): Promise<PluginMatch[] | undefined> {
    const generation = ++this.generation;
    const plugins = await this.readPlugins();
    if (plugins === undefined || generation !== this.generation) return undefined;
    this.facts.reconciled(plugins, failures);
    // Diagnoses stay as the last scan left them (no blink) until `scanDiagnoses` below lands a
    // fresh answer; a failed scan leaves them alone too.
    this._onDidChangeTreeData.fire(undefined);
    // Fire-and-forget: the tree hand-off must not wait on a whole-load-order scan. A failed scan is
    // ADR-0019's background tier, and retries at the next reconcile.
    void this.scanDiagnoses(generation);
    return plugins.map((p) => ({ name: p.name, hasMatchingRecords: p.hasMatchingRecords }));
  }

  /** Re-reads the facts alone, leaving the held load order as it is. `undefined` when the read
   *  failed. A later re-read wins, and none supersedes a reconcile's hand-off, the only answer
   *  to which plugins are held. */
  async refreshFacts(): Promise<PluginMatch[] | undefined> {
    const generation = this.generation;
    const factsRead = ++this.factsRead;
    const plugins = await this.readPlugins();
    if (plugins === undefined || generation !== this.generation || factsRead !== this.factsRead) return undefined;
    this.facts.refreshed(plugins);
    this._onDidChangeTreeData.fire(undefined);
    return plugins.map((p) => ({ name: p.name, hasMatchingRecords: p.hasMatchingRecords }));
  }

  // The plugins of the rows the tree shows, joined by (origin, filename). A failed read is never
  // swallowed into an empty list, which would read as "nothing held".
  private async readPlugins(): Promise<PluginMetadata[] | undefined> {
    if (!this.client) return undefined;
    try {
      const shown = new Set(this.builtRows().map((row) => pluginAddressKey(addressOfRow(row))));
      return (await this.client.getPlugins()).filter((p) => shown.has(pluginAddressKey(p)));
    } catch (err) {
      const message = errorMessage(err);
      this.log('error', `[PluginsTreeProvider] reading the backend's plugin list failed: ${message}`);
      this.facts.unreachable(message);
      // Briefly over-showing rows beats freezing every one behind a stale filter answer.
      this.facts.matchesUnknown();
      this._onDidChangeTreeData.fire(undefined);
      return undefined;
    }
  }

  private async scanDiagnoses(generation: number): Promise<void> {
    if (!this.client) return;
    try {
      const reports = await this.client.getDiagnoses();
      if (generation !== this.generation) return;
      // One derivation, two surfaces — the tree badge and the Problems panel cannot disagree.
      this.facts.diagnosed(reports);
      this.publishDiagnoses?.(this.facts.problems().malformed);
      this._onDidChangeTreeData.fire(undefined);
    } catch (err) {
      this.log('warn', `[PluginsTreeProvider] the malformed-plugin scan could not be read: ${errorMessage(err)}`);
    }
  }

  private isHiddenByFilter(row: PluginListNode): boolean {
    return this.facts.hiddenByRecordFilter(addressOfRow(row));
  }

  // ── drag and drop ─────────────────────────────────────────────────────────

  /** VS Code passes the whole selection when the grabbed row is part of it, so `source` is the
   *  full block to move. Non-plugin rows cannot move. */
  handleDrag(
    source: readonly PluginsTreeNode[],
    dataTransfer: vscode.DataTransfer,
    _token: vscode.CancellationToken,
  ): void {
    const plugins = source.filter((n): n is PluginNode => n instanceof PluginNode)
      .map(addressOfRow);
    if (plugins.length === 0) return;
    dataTransfer.set(DND_MIME, new vscode.DataTransferItem({ plugins }));
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
    const { plugins: moved } = payload.value;
    const names = moved.map((p) => p.name);
    const drop = this.dropFor(target, names);
    if (drop === undefined) return;
    try {
      const refusal = moveOrderRefusal(this.lastOrder.map((line) => line.name), names, drop, this.orderFacts());
      if (refusal !== undefined) {
        this.reporter?.report('error', 'Could not move plugins.', refusal);
        return;
      }
      await runWritingGesture(PLUGINS_KEY_ARGS.view, this.instance, () => this.source.reorderPlugins(names, drop));
    } catch (e) {
      this.log('info', `[PluginsTreeProvider] reorderPlugins failed: ${errorMessage(e)}`);
      this.reporter?.report('error', 'Failed to move plugins.', errorMessage(e));
    }
  }

  // Only the line's own plugin, by its origin (ADR-0012).
  private orderFacts(): PluginOrderFactsOf {
    const originOf = new Map(this.lastOrder.map((line) => [line.name, line.origin] as const));
    return (name) => {
      const origin = originOf.get(name);
      return origin === undefined ? undefined : this.facts.orderFacts({ name, origin });
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

function recordFormKeyOf(row: PluginsTreeNode): string | undefined {
  if (!isRecordRow(row)) return undefined;
  return row.kind === 'record' ? row.record.formKey : row.formKey;
}

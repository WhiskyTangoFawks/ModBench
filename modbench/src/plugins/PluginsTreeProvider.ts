import * as vscode from 'vscode';
import type { PluginDiagnosisReport, PluginAddress } from '../client';
import { lastGoodReadMessage, type Instance, type InstanceValue, type InstanceView, type PluginEntry } from '../instanceLoader/instance';
import type { SortDirection } from '../drivingLib/sortDirectionToggle';
import { firstReadOf, type FirstRead } from '../drivingLib/instanceFirstRead';
import type { PluginsDrop } from '../pluginsCommands/plugins';
import { failurePrefixIcon } from './failurePrefixIcon';
import { lockedRowUri } from './ImplicitMasterDecorationProvider';
import { IndexingNode, type PluginTreeNode, type PluginTreeProvider } from './PluginTreeProvider';
import { ErrorNode } from '../drivingLib/errorNode';
import { pluginAddressKey, samePluginAddress } from '../wire/pluginAddress';
import { placeOf, type PluginWarning } from './pluginFacts';
import { PluginFactsFeed, type PluginFactsClient } from './pluginFactsFeed';
import { isRecordRow } from './gestureEntry';
import type { RecordGroup, RecordPlace } from './createdRecordSelection';
import { headerFormKeyOf } from '../wire/headerFormKey';
import type { PluginArgument } from '../drivingLib/argument';
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

// `DataTransferItem.value` is `any`, so a dropped payload is checked, not trusted.
export function isAddress(value: unknown): value is PluginAddress {
  return typeof value === 'object' && value !== null && 'name' in value && typeof value.name === 'string'
    && 'origin' in value && typeof value.origin === 'string';
}

function isDropPayload(value: unknown): value is { plugins: PluginAddress[] } {
  return typeof value === 'object' && value !== null && 'plugins' in value && Array.isArray(value.plugins)
    && value.plugins.every(isAddress);
}

/** The record browser a row's children are delegated to (ADR-0017). `PluginTreeProvider`
 *  satisfies it. */
export type RecordBrowser = Pick<
  PluginTreeProvider,
  'getPluginChildren' | 'getChildren' | 'getTreeItem' | 'onDidChangeTreeData'
>;

interface PluginsTreeProviderOptions {
  /** Name, origin, slot, enabled and winning for every plugin: the row input. */
  instance: PluginsInstance;
  /** A row's children. */
  records: RecordBrowser;
  /** Every plugin-keyed fact. */
  client: PluginFactsClient;
  /** The malformed-plugin scan's other surface, the Problems panel, which needs an instance root
   *  this provider has no business knowing. */
  publishDiagnoses: (reports: PluginDiagnosisReport[]) => void;
  /** The Changed outside Modbench status's other surface, the Problems panel: a warning for every
   *  such plugin. */
  publishChangedOutside: (warnings: readonly PluginWarning[]) => void;
  /** This provider states the severity (ADR-0019), so a background blip and a failed
   *  read land on different channel levels. */
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
  /** The Instance adapter's path of a file at the root of the Data folder, read fresh at each
   *  call: the game folder setting is editable while Modbench runs. `undefined` while the folder
   *  is not found. */
  dataFolderFile: (name: string) => string | undefined;
}


// plugins.md, A row, Identity: VS Code keeps expansion and selection across a rebuild by it, and
// refuses two rows that share one.
function rowIdentity(kind: string, plugin: PluginAddress, formKey?: string): string {
  return [kind, pluginAddressKey(plugin), ...(formKey === undefined ? [] : [formKey])].join(':');
}

function openHeaderCommand(header: PluginAddress): vscode.Command {
  return { command: 'modbench.record.open', title: 'Open Record', arguments: [{ argument: { kind: 'record', formKey: headerFormKeyOf(header), plugin: header } }] };
}

/** No `resourceUri`: VS Code infers a base icon from one unless `iconPath` overrides it, so
 *  setting one would silently change every row's icon. Overridden plugins:
 *  plugins.md, The tree, story 3. */
export class PluginNode extends vscode.TreeItem {
  readonly kind = 'plugin' as const;
  readonly argument: PluginArgument;
  constructor(
    public readonly plugin: PluginEntry,
    /** Which plugin of the name this row stands for (ADR-0012), the join key for every fact. */
    public readonly origin: string,
  ) {
    super(plugin.name, vscode.TreeItemCollapsibleState.None);
    this.argument = { kind: 'plugin', plugin: { name: plugin.name, origin } };
    this.id = rowIdentity(this.kind, { name: plugin.name, origin });
    this.contextValue = `plugin ${plugin.enabled ? 'enabled' : 'disabled'}`;
    // xEdit parity: selecting a plugin node shows its File Header, with no separate affordance.
    // plugins.md, Menus and keys, story 2: the game loads no disabled plugin's records, so a click
    // on its row only selects it.
    if (plugin.enabled) this.command = openHeaderCommand({ name: plugin.name, origin });
    this.checkboxState = plugin.enabled
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
  }
}

/** A lock stands in for the reference tool's checkbox (plugins.md, A plugin the game loads with
 *  no line). */
export class ImplicitMasterNode extends vscode.TreeItem {
  readonly kind = 'implicitMaster' as const;
  readonly argument: PluginArgument;
  constructor(public readonly name: string, public readonly origin: string, path?: string) {
    super(name, vscode.TreeItemCollapsibleState.None);
    this.argument = { kind: 'plugin', plugin: { name, origin } };
    this.id = rowIdentity(this.kind, { name, origin });
    this.contextValue = 'pluginImplicit';
    this.iconPath = new vscode.ThemeIcon('lock');
    // plugins.md, A plugin the game loads with no line: the reference tool's one sentence alone —
    // the label already shows the greyed file name, so the tooltip does not repeat it.
    this.tooltip = "This plugin can't be disabled or moved (enforced by the game).";
    this.command = openHeaderCommand({ name, origin });
    if (path !== undefined) this.resourceUri = lockedRowUri(path);
  }
}

const LOSING_END: PluginsDrop = { kind: 'losingEnd' };
const WINNING_END: PluginsDrop = { kind: 'winningEnd' };
const BOTTOM_OF_THE_VIEW = 'Bottom of the view';

/** plugins.md, States, story 1: an empty list says so on the message line, never as a row.
 *  @public Read by packageJson.test, which holds package.json to it. */
export const NO_PLUGINS_MESSAGE =
  'No plugins: plugins.txt lists none, and mEdit names none the game loads on its own. Create Plugin…, in the title bar, adds one.';

export type PluginListNode = PluginNode | ImplicitMasterNode;

/** What this tree hands VS Code: a load-order row, or one of the record browser's nodes under
 *  it. */
export type PluginsTreeNode = PluginListNode | PluginTreeNode;

// The view is shared, so a drop must be able to tell these rows from another provider's.
const OWN_ROW_KINDS = new Set<string>(['plugin', 'implicitMaster']);

function pluginFileOf(node: PluginListNode): string {
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

  private readonly dataFolderFile: (name: string) => string | undefined;
  private readonly instance: PluginsInstance;
  private readonly records: RecordBrowser;
  private instanceValue: InstanceValue;
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly firstRead: FirstRead;
  private filterText = '';
  private filterLower = '';
  private direction: SortDirection = 'losingAtTop';
  private recordFilterSource?: string;
  private recordFilterMatchesNothing = false;
  // Unfiltered rows, so a filter keystroke re-renders instead of re-walking the Instance value.
  // A new Instance value clears it; `render()` leaves it intact.
  private cache?: { rows: PluginListNode[] };
  private lastBuildHadNoRows = false;
  private lastLockedRowUris: ReadonlySet<string> = new Set();

  constructor(options: PluginsTreeProviderOptions) {
    this.dataFolderFile = options.dataFolderFile;
    this.instance = options.instance;
    this.records = options.records;
    this.facts = new PluginFactsFeed({
      client: options.client,
      shownPlugins: () => this.builtRows().map(addressOfRow),
      publishDiagnoses: options.publishDiagnoses,
      publishChangedOutside: options.publishChangedOutside,
      log: options.log,
    });
    this.instanceValue = options.instance.value;
    this.firstRead = firstReadOf(options.instance);
    this.subscriptions.push(this.firstRead, options.instance.subscribe((value) => {
      this.instanceValue = value;
      this.cache = undefined;
      this._onDidChangeTreeData.fire(undefined);
    }), options.instance.onReadFailure(() => this.render()));
    this.subscriptions.push(
      options.records.onDidChangeTreeData((child) => this._onDidChangeTreeData.fire(child)),
      this.facts,
      this.facts.onDidChange(() => this._onDidChangeTreeData.fire(undefined)),
    );
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
    this._onDidChangeTreeData.dispose();
  }

  // ── rows ──────────────────────────────────────────────────────────────────

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

  // The game folder not found (common.md, States 5), a failed index (plugins.md, States 6), no rows
  // (States 1), a record filter matching nothing (States 5): the first that holds.
  private firstHeldMessage(): string | undefined {
    const { gameFolder } = this.instanceValue;
    if (this.instance.sequence !== 0 && gameFolder.kind !== 'found') {
      return `Game folder not found: set ${gameFolder.setting}. The Toolbox's Game row names each place Modbench looked.`;
    }
    return this.facts.rows.indexFailureMessage()
      ?? (this.lastBuildHadNoRows ? NO_PLUGINS_MESSAGE : undefined)
      ?? (this.recordFilterSource === undefined ? undefined : this.facts.rows.noRecordMatchMessage(this.recordFilterSource));
  }

  /** The source of the record filter in force, which the no-match message names; undefined while
   *  none is. */
  setRecordFilterSource(source: string | undefined): void {
    if (source !== this.recordFilterSource) this.facts.forgetMatches();
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
      ? await this.expandPluginRow(element)
      : await this.records.getChildren(element);
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

  /** The row of a record, once mEdit lists it where it landed. */
  async recordRow(place: RecordPlace<PluginsTreeNode>, formKey: string): Promise<PluginsTreeNode | undefined> {
    const parent = 'container' in place ? await this.currentRow(place.container) : await this.groupRow(place);
    return parent && this.recordRowBeneath(parent, formKey);
  }

  private async groupRow({ plugin, recordType }: RecordGroup): Promise<PluginsTreeNode | undefined> {
    const pluginRow = (await this.rows()).find((row) => row.kind === 'plugin' && samePluginAddress(addressOfRow(row), plugin));
    if (pluginRow === undefined) return undefined;
    return (await this.getChildren(pluginRow)).find((row) => row.kind === 'recordType' && row.recordType === recordType);
  }

  // A row from before a rebuild still expands, but VS Code tells a row with no id from its new
  // copy by label and position, so a reveal through it would not find the row it shows.
  private async currentRow(row: PluginsTreeNode): Promise<PluginsTreeNode | undefined> {
    const parent = this.parentOf.get(row);
    const siblings = parent === undefined ? await this.rows() : await this.childrenOfCurrent(parent);
    return siblings.find((sibling) => sibling.kind === row.kind && (sibling.id ?? sibling.label) === (row.id ?? row.label));
  }

  private async childrenOfCurrent(row: PluginsTreeNode): Promise<PluginsTreeNode[]> {
    const current = await this.currentRow(row);
    return current === undefined ? [] : this.getChildren(current);
  }

  // A group's or a container's records sit beneath it directly, or beneath rows that stand for no
  // record, as blocks do. A record row ends the walk: what it holds is its own.
  private async recordRowBeneath(parent: PluginsTreeNode, formKey: string): Promise<PluginsTreeNode | undefined> {
    for (const row of await this.getChildren(parent)) {
      if (isRecordRow(row)) {
        if (recordFormKeyOf(row) === formKey) return row;
        continue;
      }
      const found = await this.recordRowBeneath(row, formKey);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  private async expandPluginRow(element: PluginListNode): Promise<PluginsTreeNode[]> {
    const address = addressOfRow(element);
    const expansion = this.facts.rows.expansion(address);
    if (expansion.kind === 'error') return [new ErrorNode(expansion.message)];
    if (expansion.kind === 'indexing') return [new IndexingNode()];
    return this.records.getPluginChildren(address, this.facts.rows.conditions(address));
  }

  private async rows(): Promise<(PluginListNode | ErrorNode)[]> {
    await this.firstRead.settled; // never claim "No plugins" before the Instance has actually read one
    if (this.firstRead.failure !== undefined) return [new ErrorNode(this.firstRead.failure)];
    return this.shownRows();
  }

  /** The row the tree now shows under the id of `row`, which VS Code may still hold from before a
   *  rebuild; undefined when the plugin is gone or the name filter hides it. */
  shownRow(row: PluginsTreeNode): PluginListNode | undefined {
    return isRow(row) ? this.shownRows().find((shown) => shown.id === row.id) : undefined;
  }

  private rowsInViewOrder(): PluginListNode[] {
    const losingFirst = this.builtRows();
    return this.direction === 'winningAtTop' ? [...losingFirst].reverse() : losingFirst;
  }

  private shownRows(): PluginListNode[] {
    const built = this.rowsInViewOrder();
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
    if (!isRow(element)) return this.records.getTreeItem(element);
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
    const icon = this.facts.rows.icon(address);
    if (icon !== undefined) {
      row.iconPath = icon === 'warning' ? warningIcon() : failurePrefixIcon();
      row.description = this.facts.rows.description(address);
    }
    row.tooltip = this.facts.rows.tooltipLines(address).join('\n');
    row.contextValue = this.contextValueOf(row, address);
  }

  // plugins.md, Menus and keys: what every plugin menu condition reads. Where the plugin lives and
  // whether its line is enabled are the instance value's; tracked and editable wait on mEdit.
  private contextValueOf(row: PluginNode, address: PluginAddress): string {
    const place = placeOf(row.origin, { modDirs: this.instanceValue.paths.modDirs, trackedMods: this.instanceValue.trackedMods });
    return ['plugin', row.plugin.enabled ? 'enabled' : 'disabled', ...(place === undefined ? [] : [place]), ...this.facts.rows.contextFlags(address)]
      .join(' ');
  }

  /** The reconcile narrator's events go in here. */
  readonly facts: PluginFactsFeed;

  private isHiddenByFilter(row: PluginListNode): boolean {
    return this.facts.rows.hiddenByRecordFilter(addressOfRow(row));
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

  async handleDrop(
    target: PluginsTreeNode | undefined,
    dataTransfer: vscode.DataTransfer,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    const payload = dataTransfer.get(DND_MIME);
    if (!payload || !isDropPayload(payload.value)) return;
    const { plugins } = payload.value;
    const drop = this.dropFor(target, plugins.map((p) => p.name));
    if (drop === undefined) return;
    await vscode.commands.executeCommand('modbench.plugin.move', plugins, drop);
  }

  /** plugins.md, Move: the block lands as a drop there lands. A block never lands above a plugin
   *  the game loads with no line, so its row is no place to offer. */
  movePlaces(names: readonly string[]): { label: string; drop: PluginsDrop }[] {
    const lineRows = this.rowsInViewOrder().filter((row): row is PluginNode => row instanceof PluginNode);
    const targets = [...lineRows.map((row) => [row.plugin.name, row] as const), [BOTTOM_OF_THE_VIEW, undefined] as const];
    return targets.flatMap(([label, target]) => {
      const drop = this.dropFor(target, names);
      return drop === undefined ? [] : [{ label, drop }];
    });
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

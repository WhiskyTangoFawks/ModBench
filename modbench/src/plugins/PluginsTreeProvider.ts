import * as vscode from 'vscode';
import type {
  PluginDiagnosisReport, PluginLoadFailure, PluginMetadata, MEditClient, LoadOrderRefusal, PluginAddress,
  NotificationEvent,
} from '../client';
import { lastGoodReadMessage, type InstanceValue, type InstanceView, type PluginEntry } from '../instanceLoader/instance';
import { firstReadOf, type FirstRead } from '../drivingLib/instanceFirstRead';
import type { Reporter } from '../ports/reporter';
import { headerFormKeyFor } from './formKeyIdentity';
import type { PluginsDrop } from '../pluginsCommands/plugins';
import { moveOrderRefusal, type PluginOrderFacts, type PluginOrderFactsOf } from '../pluginsCommands/pluginOrder';
import { failurePrefixIcon } from './failurePrefixIcon';
import { lockedRowUri } from './ImplicitMasterDecorationProvider';
import { IndexingNode, type PluginConditions, type PluginTreeNode, type PluginTreeProvider } from './PluginTreeProvider';
import { ErrorNode } from '../drivingLib/errorNode';
import { pluginAddressKey } from './trackedRepositories';
import { isRecordRow } from './gestureEntry';
import type { RecordGroup } from './createdRecordSelection';
import {
  MARK_DELAY_MS, UNCONFIRMED_TOOLTIP, UnconfirmedRecordRows, type MarkedRow,
} from './unconfirmedRecordRows';
import { errorMessage } from '../ports/errorMessage';
import { DATA_DIRECTORY_ORIGIN, OVERWRITE_ORIGIN } from '../instanceLoader/loadOrderSnapshot';

const DND_MIME = 'application/vnd.medit.pluginlist-node';

function whatTheDiskShows(shown: boolean | undefined, on: string, off: string): string {
  if (shown === undefined) return 'it is gone from the disk';
  return `the disk now shows it ${shown ? on : off}`;
}

interface UnconfirmedWrite {
  readonly name: string;
  readonly enabled: boolean;
  marked: boolean;
  differedOnce: boolean;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface UnconfirmedShape {
  readonly moved: PluginAddress[];
  readonly covered: (value: InstanceValue) => boolean;
  marked: boolean;
  differedOnce: boolean;
  readonly timer: ReturnType<typeof setTimeout>;
}

const sameAddress = (a: PluginAddress, b: PluginAddress): boolean => a.name === b.name && a.origin === b.origin;

// One entry per plugins.txt line: the winning plugin of every listed name, in file order
// (plugins.md, The tree, stories 1 and 3). An overridden plugin carries the same slot and is
// excluded.
function listedPlugins(value: InstanceValue): (InstanceValue['plugins'][number] & { slot: number })[] {
  return value.plugins
    .filter((p): p is InstanceValue['plugins'][number] & { slot: number } => p.slot !== null && p.winning)
    .sort((a, b) => a.slot - b.slot);
}

const orderOf = (value: InstanceValue): string[] => listedPlugins(value).map((p) => pluginAddressKey(p.name, p.origin));

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
export type PluginFactsClient = Pick<MEditClient, 'getPlugins' | 'getDiagnoses' | 'onStatusChanged' | 'subscribe' | 'getRecordHolders'>;

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

/** A warning on one plugin's file, as the Problems panel shows it. */
export type PluginWarning = Pick<PluginDiagnosisReport, 'plugin' | 'origin' | 'text'>;

export interface PluginsTreeProviderOptions {
  /** Name, origin, slot, enabled and winning for every plugin: the row input. */
  instance: InstanceView;
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
  return [kind, pluginAddressKey(plugin.name, plugin.origin), ...(formKey === undefined ? [] : [formKey])].join(':');
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
  masterIssues?: string[];
  // Whether this plugin holds a record that could not be read into its document.
  parseFailure?: boolean;
  order?: PluginOrderFacts;
}

// Every fact is filed and read under origin and filename (ADR-0012).
class ByPluginAddress<T> {
  private readonly byAddress = new Map<string, T>();

  set(name: string, origin: string, value: T): void {
    this.byAddress.set(pluginAddressKey(name, origin), value);
  }

  // `this` narrows to an array-valued instance.
  append<U>(this: ByPluginAddress<U[]>, name: string, origin: string, item: U): void {
    const addressKey = pluginAddressKey(name, origin);
    this.byAddress.set(addressKey, [...(this.byAddress.get(addressKey) ?? []), item]);
  }

  get(name: string, origin: string): T | undefined {
    return this.byAddress.get(pluginAddressKey(name, origin));
  }

  has(name: string, origin: string): boolean {
    return this.byAddress.has(pluginAddressKey(name, origin));
  }
}

type RowDecoration = {
  description: vscode.TreeItem['description'];
  iconPath: vscode.TreeItem['iconPath'];
};

// What a row not resolved by the load order shows (plugins.md, States, stories 3, 4 and 6).
// `everyRow`: a second window (ADR-0009). `unheldRow`: mEdit unreachable, or a `Failed` reconcile.
type ExpansionOverride = { scope: 'everyRow' | 'unheldRow'; message: string };

// plugins.md, A row: the five statuses, in the order that sets the icon. `words` is the
// description's vocabulary; `tooltipLine` is that status's one tooltip line.
interface PluginStatus {
  kind: 'failedToRead' | 'masterIssues' | 'unreadableRecords' | 'changedOutside' | 'malformed';
  words: string;
  tooltipLine: string;
}

// The yellow status icon (plugins.md, A row). A plugin changed outside Modbench or malformed still
// loads and plays, unlike the three red statuses.
function warningIcon(): vscode.ThemeIcon {
  return new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'));
}

function failedToReadStatus(failure: string | undefined): PluginStatus | undefined {
  if (failure === undefined) return undefined;
  return { kind: 'failedToRead', words: 'failed to read', tooltipLine: `Failed to read: ${failure}` };
}

// "Missing" is the reference tool's word for a master that is not active, file present or not.
function masterIssuesStatus(inactiveMasters: string[]): PluginStatus | undefined {
  if (inactiveMasters.length === 0) return undefined;
  const words = inactiveMasters.length === 1 ? '1 master issue' : `${inactiveMasters.length} master issues`;
  return { kind: 'masterIssues', words, tooltipLine: `Missing masters: ${inactiveMasters.join(', ')}` };
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

// The status's words beyond the row, in its tooltip and the Problems panel.
const CHANGED_OUTSIDE_TEXT = 'Changed outside Modbench: its bytes differ from what Modbench last wrote.';

function changedOutsideStatus(changed: boolean): PluginStatus | undefined {
  if (!changed) return undefined;
  return {
    kind: 'changedOutside', words: 'changed outside Modbench',
    tooltipLine: CHANGED_OUTSIDE_TEXT,
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
  private readonly dataFolderFile: (name: string) => string | undefined;
  private readonly instance: InstanceView;
  private readonly records?: RecordBrowser;
  private readonly client?: PluginFactsClient;
  private readonly publishDiagnoses?: (reports: PluginDiagnosisReport[]) => void;
  private readonly publishChangedOutside?: (warnings: readonly PluginWarning[]) => void;
  private instanceValue: InstanceValue;
  private readonly unconfirmed = new Map<string, UnconfirmedWrite>();
  private readonly unconfirmedShapes = new Set<UnconfirmedShape>();
  private readonly unconfirmedRecords: UnconfirmedRecordRows;
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
      this.settleUnconfirmed(value);
      this.instanceValue = value;
      this.invalidate();
    }), options.instance.onReadFailure(() => this.render()));
    if (options.records) {
      this.subscriptions.push(options.records.onDidChangeTreeData((child) => this._onDidChangeTreeData.fire(child)));
    }
    const unsubscribeChanges = options.client?.subscribe('external-change', (event) => this.applyExternalChange(event));
    if (unsubscribeChanges) this.subscriptions.push({ dispose: unsubscribeChanges });
    this.unconfirmedRecords = new UnconfirmedRecordRows({
      client: options.client, log: (line) => this.log('warn', `[PluginsTreeProvider] ${line}`), render: () => this.render(),
    });
    const unsubscribeRows = options.client?.subscribe('rows-changed',
      (event) => this.unconfirmedRecords.rowsChanged({ name: event.plugin, origin: event.origin }, event.keys));
    if (unsubscribeRows) this.subscriptions.push({ dispose: unsubscribeRows });
  }

  /** The rows a record write changes, marked until mEdit's index shows it (common.md, Unconfirmed
   *  writes). */
  get recordMarks(): Pick<UnconfirmedRecordRows, 'creating' | 'deleting' | 'copying'> {
    return this.unconfirmedRecords;
  }

  // plugins.md, A row: each settle of a tracked mod names every plugin of it that changed outside
  // Modbench, so it replaces what the mod's last settle named.
  private applyExternalChange(event: NotificationEvent): void {
    this.changedOutsideByMod.set(event.origin, (event.changedPlugins ?? []).map(({ name }) => ({ name, origin: event.origin })));
    const changed = [...this.changedOutsideByMod.values()].flat();
    this.changedOutside = new ByPluginAddress<true>();
    for (const { name, origin } of changed) this.changedOutside.set(name, origin, true);
    this.publishChangedOutside?.(changed.map(({ name, origin }) => ({ plugin: name, origin, text: CHANGED_OUTSIDE_TEXT })));
    this._onDidChangeTreeData.fire(undefined);
  }

  dispose(): void {
    this.clearUnconfirmed();
    this.unconfirmedRecords.dispose();
    for (const subscription of this.subscriptions) subscription.dispose();
    this._onDidChangeTreeData.dispose();
  }

  private settleUnconfirmed(value: InstanceValue): void {
    for (const [address, write] of this.unconfirmed) {
      const disk = value.plugins.find((p) => p.winning && pluginAddressKey(p.name, p.origin) === address);
      if (disk?.enabled !== write.enabled) {
        if (!write.differedOnce) {
          write.differedOnce = true;
          continue;
        }
        this.log('warn', `[PluginsTreeProvider] "${write.name}" was written ${write.enabled ? 'enabled' : 'disabled'}, and ${whatTheDiskShows(disk?.enabled, 'enabled', 'disabled')}.`);
      }
      clearTimeout(write.timer);
      this.unconfirmed.delete(address);
    }
    this.settleUnconfirmedShapes(value);
  }

  private settleUnconfirmedShapes(value: InstanceValue): void {
    for (const shape of this.unconfirmedShapes) {
      if (!shape.covered(value)) {
        if (!shape.differedOnce) {
          shape.differedOnce = true;
          continue;
        }
        this.log('warn', `[PluginsTreeProvider] ${shape.moved.map(({ name }) => `"${name}"`).join(', ')} was moved, and the disk does not show the move.`);
      }
      this.dropShape(shape);
    }
  }

  private dropShape(shape: UnconfirmedShape): void {
    clearTimeout(shape.timer);
    this.unconfirmedShapes.delete(shape);
  }

  private markMoved(moved: readonly PluginAddress[]): void {
    if (moved.length === 0) return;
    const movedKeys = new Set(moved.map(({ name, origin }) => pluginAddressKey(name, origin)));
    const rest = (value: InstanceValue) => orderOf(value).filter((key) => !movedKeys.has(key)).join('\n');
    const before = orderOf(this.instanceValue).join('\n');
    const restBefore = rest(this.instanceValue);
    const shape: UnconfirmedShape = {
      moved: [...moved], covered: (value) => orderOf(value).join('\n') !== before && rest(value) === restBefore, marked: false, differedOnce: false,
      timer: setTimeout(() => {
        shape.marked = true;
        this.render();
      }, MARK_DELAY_MS),
    };
    this.unconfirmedShapes.add(shape);
  }

  private forgetMoved(moved: readonly PluginAddress[]): void {
    let shown = false;
    for (const shape of this.unconfirmedShapes) {
      const left = shape.moved.filter((own) => !moved.some((forgotten) => sameAddress(forgotten, own)));
      shown ||= shape.marked && left.length < shape.moved.length;
      shape.moved.splice(0, shape.moved.length, ...left);
      if (left.length === 0) this.dropShape(shape);
    }
    if (shown) this.render();
  }

  private isMarked(address: PluginAddress): boolean {
    return this.unconfirmed.get(pluginAddressKey(address.name, address.origin))?.marked === true || this.shapeMarked(address)
      || this.unconfirmedRecords.isMarked({ plugin: address });
  }

  private shapeMarked(address: PluginAddress): boolean {
    return [...this.unconfirmedShapes].some((shape) => shape.marked && shape.moved.some((row) => sameAddress(row, address)));
  }

  /** A check box's new state shows at once; the mark follows after a delay. */
  markUnconfirmed(row: PluginNode, enabled: boolean): void {
    const address = pluginAddressKey(row.plugin.name, row.origin);
    clearTimeout(this.unconfirmed.get(address)?.timer);
    const write: UnconfirmedWrite = {
      name: row.plugin.name, enabled, marked: false, differedOnce: false,
      timer: setTimeout(() => {
        write.marked = true;
        this.render();
      }, MARK_DELAY_MS),
    };
    this.unconfirmed.set(address, write);
    this.cache = undefined;
    this.render();
  }

  /** A refused or failed write shows the disk's value at once, with no mark. */
  forgetUnconfirmed(row: PluginNode): void {
    const address = pluginAddressKey(row.plugin.name, row.origin);
    clearTimeout(this.unconfirmed.get(address)?.timer);
    this.unconfirmed.delete(address);
    this.invalidate();
  }

  private clearUnconfirmed(): void {
    for (const write of this.unconfirmed.values()) clearTimeout(write.timer);
    this.unconfirmed.clear();
    for (const shape of this.unconfirmedShapes) clearTimeout(shape.timer);
    this.unconfirmedShapes.clear();
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

  // The first that holds: the game folder not found (common.md, States 5), a failed index
  // (plugins.md, States 6), no rows (States 1), a record filter matching nothing (States 5).
  private firstHeldMessage(): string | undefined {
    const { gameFolder } = this.instanceValue;
    if (this.instance.sequence !== 0 && gameFolder.kind !== 'found') {
      return `Game folder not found: set ${gameFolder.setting}. The Toolbox's Game row names each place Modbench looked.`;
    }
    if (this.indexFailure !== undefined) return `Indexing failed: ${this.indexFailure}`;
    if (this.lastBuildHadNoRows) return NO_PLUGINS_MESSAGE;
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

  /** The row's own file (ADR-0012), or the game folder's copy
   *  for a game-folder row the Instance value lists no file for. */
  resolvePluginPath(row: PluginNode | ImplicitMasterNode): Promise<string | undefined> {
    const name = pluginFileOf(row);
    const address = pluginAddressKey(name, row.origin);
    const listed = this.instanceValue.plugins.find((p) => pluginAddressKey(p.name, p.origin) === address)?.path;
    return Promise.resolve(listed ?? (row.origin === DATA_DIRECTORY_ORIGIN ? this.dataFolderFile(name) : undefined));
  }

  /** Whether the row's line is enabled now: a row the view still holds may predate the value. */
  isEnabled(row: PluginNode): boolean {
    const address = pluginAddressKey(row.plugin.name, row.origin);
    const written = this.unconfirmed.get(address);
    if (written !== undefined) return written.enabled;
    return this.instanceValue.plugins.some((p) => p.winning && p.enabled && pluginAddressKey(p.name, p.origin) === address);
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
    return current && { name: pluginFileOf(current), origin: current.origin };
  }

  /** The row of a record, once mEdit lists it in its group. */
  async recordRow({ plugin, recordType }: RecordGroup, formKey: string): Promise<PluginsTreeNode | undefined> {
    const address = pluginAddressKey(plugin.name, plugin.origin);
    const pluginRow = (await this.rows()).find((row) => row.kind === 'plugin' && pluginAddressKey(row.plugin.name, row.origin) === address);
    if (pluginRow === undefined) return undefined;
    const group = (await this.getChildren(pluginRow)).find((row) => row.kind === 'recordType' && row.recordType === recordType);
    if (group === undefined) return undefined;
    return (await this.getChildren(group)).find((row) => row.kind === 'record' && row.record.formKey === formKey);
  }

  // plugins.md, States 2-4: what a plugin row expands into, in precedence order.
  private async expandPluginRow(element: PluginListNode, file: string): Promise<PluginsTreeNode[]> {
    if (this.expansionOverride?.scope === 'everyRow') return [new ErrorNode(this.expansionOverride.message)];
    if (this.held?.has(file, element.origin) === true) {
      return this.records?.getPluginChildren(file, element.origin, this.conditionsOf(element, file)) ?? noRecordBrowser();
    }
    // plugins.md, States, stories 2, 3 and 6.
    const failure = this.reachableFailureOf(element);
    if (failure !== undefined) return [new ErrorNode(failure)];
    if (this.expansionOverride?.scope === 'unheldRow') return [new ErrorNode(this.expansionOverride.message)];
    return [new IndexingNode()];
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
    const implicitLower = new Set(loadedWithNoLine.map((p) => p.name.toLowerCase()));

    const listed = listedPlugins(this.instanceValue);

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
    const lockedRows = loadedWithNoLine.map(({ name, origin }) => new ImplicitMasterNode(name, origin, this.dataFolderFile(name)));
    this.lastLockedRowUris = new Set(lockedRows.flatMap((row) => (row.resourceUri ? [row.resourceUri.toString()] : [])));
    return [
      ...lockedRows,
      ...dedupedOrder.map((p) => new PluginNode({
        name: p.name, enabled: this.unconfirmed.get(pluginAddressKey(p.name, p.origin))?.enabled ?? p.enabled,
      }, p.origin)),
    ];
  }

  // ── the tree item ─────────────────────────────────────────────────────────

  getTreeItem(element: PluginsTreeNode): vscode.TreeItem {
    if (!isRow(element)) return this.markedBeneath(this.records?.getTreeItem(element) ?? element, element);
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

  private readonly unmarkedLook = new WeakMap<object, Pick<vscode.TreeItem, 'iconPath' | 'tooltip'>>();

  private markedBeneath(item: vscode.TreeItem, element: PluginsTreeNode): vscode.TreeItem {
    const plugin = this.pluginOf(element);
    const row = plugin && markedRowOf(element, plugin);
    const base = this.unmarkedLook.get(item) ?? { iconPath: item.iconPath, tooltip: item.tooltip };
    this.unmarkedLook.set(item, base);
    const marked = row !== undefined && this.unconfirmedRecords.isMarked(row);
    item.iconPath = marked ? new vscode.ThemeIcon('sync~spin') : base.iconPath;
    item.tooltip = marked ? UNCONFIRMED_TOOLTIP : base.tooltip;
    return item;
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
    const statuses = this.statusesOf(row);
    const [first] = statuses;
    if (first !== undefined) {
      row.iconPath = first.kind === 'changedOutside' || first.kind === 'malformed' ? warningIcon() : failurePrefixIcon();
      row.description = statuses.map((s) => s.words).join(', ');
    }
    const lines = [file, row.origin];
    if (this.facts?.get(file, row.origin)?.readOnly === true) lines.push('read-only');
    for (const status of statuses) lines.push(status.tooltipLine);
    row.tooltip = lines.join('\n');
    if (this.isMarked({ name: file, origin: row.origin })) {
      row.iconPath = new vscode.ThemeIcon('sync~spin');
      row.tooltip = UNCONFIRMED_TOOLTIP;
    }
    row.contextValue = this.contextValueOf(row);
  }

  // plugins.md, Menus and keys: what every plugin menu condition reads. Where the plugin lives and
  // whether its line is enabled are the instance value's; tracked and editable wait on mEdit.
  private contextValueOf(row: PluginNode): string {
    const place = this.placeOf(row.origin);
    const facts = this.facts?.get(row.plugin.name, row.origin);
    return ['plugin', row.plugin.enabled ? 'enabled' : 'disabled', ...(place === undefined ? [] : [place]), ...factFlags(facts)]
      .join(' ');
  }

  // What the rows beneath a plugin row state about it: its tracked and editable flags.
  private conditionsOf(row: PluginListNode, file: string): PluginConditions {
    const facts = this.facts?.get(file, row.origin);
    return { tracked: facts?.tracked === true, editable: facts?.readOnly === false };
  }

  // The instance value names each mod's folder, whatever the mod manager calls the others, and
  // each mod whose folder holds a repository.
  private placeOf(origin: string): 'inTrackedMod' | 'inUntrackedMod' | 'inOverwrite' | undefined {
    if (origin === OVERWRITE_ORIGIN) return 'inOverwrite';
    const folded = origin.toLowerCase();
    const mod = [...this.instanceValue.paths.modDirs.keys()].find((name) => name.toLowerCase() === folded);
    if (mod === undefined) return undefined;
    return this.instanceValue.trackedMods.has(mod) ? 'inTrackedMod' : 'inUntrackedMod';
  }

  /** Whether compile applies to any plugin, which compile's palette entry reads. */
  anyCompilable(): boolean {
    return this.someCompilable;
  }

  // plugins.md, Menus and keys: compile (tracked). A plugin that is not active has no record to
  // edit, yet its source still compiles.
  private compilable(file: string, origin: string): boolean {
    return this.facts?.get(file, origin)?.tracked === true;
  }

  // plugins.md, A row: every status the plugin carries, spec order.
  private statusesOf(row: PluginNode): PluginStatus[] {
    const file = row.plugin.name;
    const facts = this.facts?.get(file, row.origin);
    const statuses = [
      failedToReadStatus(this.loadFailures.get(file, row.origin)),
      masterIssuesStatus(facts?.masterIssues ?? []),
      unreadableRecordsStatus(facts?.parseFailure === true),
      changedOutsideStatus(this.changedOutside.has(file, row.origin)),
      malformedStatus(this.diagnoses?.get(file, row.origin) ?? []),
    ];
    return statuses.filter((s): s is PluginStatus => s !== undefined);
  }

  // ── the load order and its facts ──────────────────────────────────────────

  private held?: ByPluginAddress<true>;
  private facts?: ByPluginAddress<PluginFacts>;
  private someCompilable = false;
  private matches?: ByPluginAddress<boolean>;
  private diagnoses?: ByPluginAddress<string[]>;
  private readonly changedOutsideByMod = new Map<string, readonly PluginAddress[]>();
  private changedOutside = new ByPluginAddress<true>();
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
  // plugins.md, States 6: why the snapshot's index failed, until the next reconcile ticks.
  private indexFailure?: string;
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
    this.expansionOverride = undefined;
    this.indexFailure = undefined;
    this.held = heldSet(indexedPlugins);
    this.reachableFailures = indexLoadFailures(failures);
    mergeLoadFailures(this.loadFailures, failures);
    this._onDidChangeTreeData.fire(undefined);
  }

  /** The load order's own refusal (ADR-0009; plugins.md, States, stories 4 and 6). */
  applyRefused(refusal: LoadOrderRefusal): void {
    this.generation++;
    this.indexFailure = refusal.kind === 'failed' ? refusal.message : undefined;
    this.expansionOverride = { scope: refusal.kind === 'heldElsewhere' ? 'everyRow' : 'unheldRow', message: refusal.message };
    this._onDidChangeTreeData.fire(undefined);
  }

  /** mEdit confirmed unreachable (ADR-0002; plugins.md, States, story 3), as the status
   *  bar's Disconnected or Stopped says. Named on a row not yet held; never downgrades an
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
    this.unconfirmedRecords.reconciled();
    const plugins = await this.readPlugins();
    if (plugins === undefined || generation !== this.generation) return undefined;
    this.expansionOverride = undefined;
    this.indexFailure = undefined;
    this.held = heldSet(plugins);
    this.loadFailures = indexLoadFailures(failures);
    this.reachableFailures = this.loadFailures;
    this.applyPluginFacts(plugins);
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
    this.applyPluginFacts(plugins);
    this._onDidChangeTreeData.fire(undefined);
    return plugins.map((p) => ({ name: p.name, hasMatchingRecords: p.hasMatchingRecords }));
  }

  // The plugins of the rows the tree shows, joined by (origin, filename). A failed read is never
  // swallowed into an empty list, which would read as "nothing held".
  private async readPlugins(): Promise<PluginMetadata[] | undefined> {
    if (!this.client) return undefined;
    try {
      const shown = new Set(this.builtRows().map((row) => pluginAddressKey(pluginFileOf(row), row.origin)));
      return (await this.client.getPlugins()).filter((p) => shown.has(pluginAddressKey(p.name, p.origin)));
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

  // plugins.md: no `masterIssues` means not yet checked, so the last answer stays until one lands.
  private applyPluginFacts(plugins: PluginMetadata[]): void {
    const facts = new ByPluginAddress<PluginFacts>();
    const matches = new ByPluginAddress<boolean>();
    for (const p of plugins) {
      facts.set(p.name, p.origin, {
        readOnly: p.isImmutable, tracked: p.isTracked, parseFailure: p.hasParseFailure,
        masterIssues: p.masterIssues ?? this.facts?.get(p.name, p.origin)?.masterIssues,
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
    return this.matches?.get(file, row.origin) === false;
  }

  // Children expansion only (plugins.md, States 2): this reload's own ticks.
  private reachableFailureOf(row: PluginListNode): string | undefined {
    return this.reachableFailures.get(pluginFileOf(row), row.origin);
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
      .map((n) => ({ name: n.plugin.name, origin: n.origin }));
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
      this.markMoved(moved);
      await this.source.reorderPlugins(names, drop);
    } catch (e) {
      this.forgetMoved(moved);
      this.log('info', `[PluginsTreeProvider] reorderPlugins failed: ${errorMessage(e)}`);
      this.reporter?.report('error', 'Failed to move plugins.', errorMessage(e));
    }
  }

  // Only the line's own plugin, by its origin (ADR-0012).
  private orderFacts(): PluginOrderFactsOf {
    const originOf = new Map(this.lastOrder.map((line) => [line.name, line.origin] as const));
    return (name) => {
      const origin = originOf.get(name);
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

function recordFormKeyOf(row: PluginsTreeNode): string | undefined {
  if (!isRecordRow(row)) return undefined;
  return row.kind === 'record' ? row.record.formKey : row.formKey;
}

function markedRowOf(row: PluginsTreeNode, plugin: PluginAddress): MarkedRow | undefined {
  if (row.kind === 'recordType') return { plugin, recordType: row.recordType };
  const formKey = recordFormKeyOf(row);
  return formKey === undefined ? undefined : { plugin, formKey };
}

function heldSet(plugins: readonly PluginAddress[]): ByPluginAddress<true> {
  const held = new ByPluginAddress<true>();
  for (const { name, origin } of plugins) held.set(name, origin, true);
  return held;
}

function indexLoadFailures(failures: PluginLoadFailure[]): ByPluginAddress<string> {
  const byAddress = new ByPluginAddress<string>();
  mergeLoadFailures(byAddress, failures);
  return byAddress;
}

function mergeLoadFailures(target: ByPluginAddress<string>, failures: PluginLoadFailure[]): void {
  for (const f of failures) target.set(f.name, f.origin, f.reason);
}


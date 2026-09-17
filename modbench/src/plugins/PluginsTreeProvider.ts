import * as vscode from 'vscode';
import { join } from 'node:path';
import type { MasterIssue, PluginDiagnosisReport, PluginLoadFailure, PluginMetadata, MEditClient } from '../medit/client';
import type { InstanceValue, InstanceView } from '../instance/instance';
import { firstReadOf, type FirstRead } from '../modmanager/instanceFirstRead';
import type { PluginEntry } from '../modmanager/model';
import type { Reporter } from '../ports/reporter';
import { dropIndexForMove } from '../mo2Codecs/pluginsText';
import type { ImplicitMasterSource } from '../modmanager/commands/plugins';
import { failurePrefixIcon } from '../failurePrefixIcon';
import { IndexingNode, type PluginTreeNode, type PluginTreeProvider } from './PluginTreeProvider';
import { ErrorNode } from '../errorNode';

const DND_MIME = 'application/vnd.medit.pluginlist-node';

// `DataTransferItem.value` is `any` — handleDrag, above `handleDrop` below, is this provider's
// only writer of it. Exported so a test narrows the same payload the same way, instead of a
// second cast of its own.
export function isDropPayload(value: unknown): value is { names: string[] } {
  if (typeof value !== 'object' || value === null) return false;
  const witness = value as { names?: unknown };
  return Array.isArray(witness.names) && witness.names.every((n): n is string => typeof n === 'string');
}

// mEdit is always running (target-architecture.md); reaching this means the tree has nothing
// held from it at all, which reads to the user the same as a disconnect.
const NOT_CONNECTED = 'mEdit is not connected.';
const notConnected = (): [ErrorNode] => [new ErrorNode(NOT_CONNECTED)];

// Hoisted out of the constructor so an omitted dependency is not a fresh closure per instance.
const NO_DATA_FOLDER: () => Promise<string | undefined> = () => Promise.resolve(undefined);
const NO_IMPLICIT_MASTERS: ImplicitMasterSource = () => Promise.resolve([]);

/** The two plugins.txt gestures the tree owns, bound to the instance root and the active
 *  profile by the composition root; a refused command reaches this provider as a rejection. */
export interface PluginListSource {
  setPluginEnabled(pluginName: string, enabled: boolean): Promise<void>;
  reorderPlugins(pluginNames: string[], toIndex: number): Promise<void>;
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
    this.tooltip = [name, "This plugin can't be disabled or moved (enforced by the game)."].join('\n');
    // Routed through the modbench.openHeader bridge command, as PluginNode's row click is.
    this.command = { command: 'modbench.openHeader', title: 'Open Header', arguments: [this] };
    if (path !== undefined) this.resourceUri = vscode.Uri.file(path);
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

/** Fired only from a real toggle, never a generic re-render, which carries nothing to apply. */
export interface PluginParticipationChange {
  plugin: string;
  enabled: boolean;
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
  tooltip: string | vscode.MarkdownString | undefined;
  description: vscode.TreeItem['description'];
  iconPath: vscode.TreeItem['iconPath'];
};

/** The one Plugins tree (ADR-0017). Rows are plugins.txt's lines, read from the Instance; their
 *  children are the record browser's; every badge comes from facts pulled once per reconcile. */
export class PluginsTreeProvider
  implements vscode.TreeDataProvider<PluginsTreeNode>, vscode.TreeDragAndDropController<PluginsTreeNode>, vscode.Disposable
{
  readonly dropMimeTypes = [DND_MIME] as const;
  readonly dragMimeTypes = [DND_MIME] as const;

  private readonly _onDidChangeTreeData = new vscode.EventEmitter<PluginsTreeNode | undefined | null>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  // Distinct from onDidChangeTreeData: see PluginParticipationChange.
  private readonly _onDidChangeParticipation = new vscode.EventEmitter<PluginParticipationChange>();
  readonly onDidChangeParticipation = this._onDidChangeParticipation.event;

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
    this.firstRead = firstReadOf(options.instance, options.reporter);
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
    this._onDidChangeParticipation.dispose();
  }

  // ── rows ──────────────────────────────────────────────────────────────────

  // Re-pulls `instance.value` rather than trusting the copy the last subscriber callback left:
  // a caller forcing a resync (a failed write, `refreshAll`) gets whatever the Instance is
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

  /** Case-insensitive substring on plugin name; an empty string clears it. Render-only, so the
   *  cache survives. */
  setFilter(text: string): void {
    this.filterText = text;
    this.filterLower = text.toLowerCase();
    this.render();
  }

  /** The write reaches disk; the Instance's own watcher is what brings the result back
   *  (ADR-0015 invariant 2). `invalidate()` here drops the cache and re-renders ahead of it. */
  async setPluginEnabled(pluginName: string, enabled: boolean): Promise<void> {
    await this.source.setPluginEnabled(pluginName, enabled);
    this.invalidate();
    this._onDidChangeParticipation.fire({ plugin: pluginName, enabled });
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
    // ADR-0002: never an empty list — that would read as "no records" (ADR-0019).
    if (this.heldFiles === undefined) return notConnected();
    if (!this.heldFiles.has(file.toLowerCase())) {
      // A plugin the load order gave up on will never be reached by a later tick — saying
      // "still indexing" would promise a completion that is not coming (ADR-0019).
      const failure = this.loadFailureOf(element);
      return [failure !== undefined ? new ErrorNode(failure) : new IndexingNode()];
    }
    // Deliberately not the row's own `origin`: a stated origin means "the copy the load order
    // does not name" downstream, which would make every record row read-only. The backend
    // resolves a load-order filename itself.
    return this.records?.getPluginChildren(file) ?? notConnected();
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
    // ADR-0002: every row is collapsible — mEdit is always running, so there is no absence for a
    // chevron to encode. `pluginFileOf` is the row's own identity, never a backend fact.
    element.collapsibleState = pluginFileOf(element) === undefined
      ? vscode.TreeItemCollapsibleState.None
      : vscode.TreeItemCollapsibleState.Collapsed;
    // A row is returned *as* its own TreeItem, so decorating in place would accumulate
    // permanently, with no way back once the condition clears.
    const base = this.captureOriginalDecoration(element);
    element.tooltip = base.tooltip;
    element.description = base.description;
    element.iconPath = base.iconPath;

    const file = pluginFileOf(element);
    if (file !== undefined) {
      const origin = this.joinOrigin(file, element);
      this.applyReadOnlyNote(element, file, origin);
      this.applyBackendDecoration(element, file, origin);
    }
    return element;
  }

  private readonly originalDecoration = new WeakMap<object, RowDecoration>();

  private captureOriginalDecoration(item: vscode.TreeItem): RowDecoration {
    const existing = this.originalDecoration.get(item);
    if (existing) return existing;
    const captured: RowDecoration = { tooltip: item.tooltip, description: item.description, iconPath: item.iconPath };
    this.originalDecoration.set(item, captured);
    return captured;
  }

  // ADR-0017: appended, never replacing, so a row's own badge survives. A MarkdownString base
  // would be replaced rather than appended to, and no row carries one.
  private applyReadOnlyNote(item: vscode.TreeItem, file: string, origin: string | undefined): void {
    if (this.facts?.get(file, origin)?.readOnly !== true) return;
    appendNote(item, `This plugin is read-only — its records can't be edited.`);
  }

  // First match wins: load failure, master issues, parse failure, then diagnoses. The lookups
  // guard a plugin the last load order never mentioned, not the wire.
  private applyBackendDecoration(row: PluginListNode, file: string, origin: string | undefined): void {
    if (this.applyErrorDecoration(row, file, origin)) return;
    // Warning tier, below the three error decorations — a Malformed plugin still loads and
    // plays; the badge says "look", not "broken".
    const texts = this.diagnoses?.get(file, origin) ?? [];
    if (texts.length > 0) this.applyDiagnosisDecoration(row, texts);
  }

  // The three error tiers, in order; answers whether one of them claimed the row.
  private applyErrorDecoration(row: PluginListNode, file: string, origin: string | undefined): boolean {
    const failure = this.loadFailureOf(row);
    if (failure !== undefined) {
      row.iconPath = failurePrefixIcon();
      row.description = '✗ Failed to load';
      appendNote(row, `Failed to load: ${failure}`);
      return true;
    }
    const facts = this.facts?.get(file, origin);
    const issues = facts?.masterIssues ?? [];
    if (issues.length > 0) {
      this.applyMasterIssueDecoration(row, issues);
      return true;
    }
    if (facts?.parseFailure !== true) return false;
    // The same prefix the record and record-type nodes carry: the backend answers "holds an
    // unreadable record" per plugin, so nothing here walks children.
    row.iconPath = failurePrefixIcon();
    row.description = '✗ Unreadable records';
    appendNote(row, 'This plugin holds a record that could not be read into its document.');
    return true;
  }

  // Text lines are `PluginDiagnosisReport.text` verbatim — the wording the Track refusal and the
  // Problems panel also carry, one vocabulary.
  private applyDiagnosisDecoration(item: vscode.TreeItem, texts: string[]): void {
    item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'));
    item.description = texts.length === 1 ? '⚠ Malformed plugin' : `⚠ ${texts.length} malformed-plugin diagnoses`;
    appendNote(item, texts.join('\n'));
  }

  // The backend's own wording, which is the only master verdict there is: nothing here reads a
  // plugin's declared masters (ADR-0016).
  private applyMasterIssueDecoration(item: vscode.TreeItem, issues: MasterIssue[]): void {
    const lines = issues.map((i) =>
      i.kind === 'DirectlyMissing' ? `Missing master: ${i.masterName}` : `Master ${i.masterName} cannot be loaded`);
    item.iconPath = failurePrefixIcon();
    item.description = lines.length === 1 ? '✗ Master issue' : `✗ ${lines.length} master issues`;
    appendNote(item, lines.join('\n'));
  }

  // ── the load order and its facts ──────────────────────────────────────────

  private heldFiles?: Set<string>;
  private facts?: ByPluginCopy<PluginFacts>;
  private matches?: ByPluginCopy<boolean>;
  private diagnoses?: ByPluginCopy<string[]>;
  private loadFailures = new ByPluginCopy<string>();
  // Bumped by every write to the held load order, so a slow read answering after a newer
  // reconcile — or after teardown — cannot resurrect a stale answer.
  private generation = 0;

  /** A progressive reconcile's tick: a row's content resolves as its plugin lands. It carries no
   *  facts — those are whole-load-order derivations a partial tick cannot answer, so they clear
   *  here and return when `applyReconciled` lands. */
  applyIndexed(indexedPlugins: string[], failures: PluginLoadFailure[]): void {
    this.generation++;
    this.heldFiles = new Set(indexedPlugins.map((n) => n.toLowerCase()));
    this.loadFailures = indexLoadFailures(failures);
    this.facts = undefined;
    this.matches = undefined;
    this.diagnoses = undefined;
    this._onDidChangeTreeData.fire(undefined);
  }

  /** The completed reconcile's whole hand-off, in one read: which files the backend holds, and
   *  every fact it answers about each copy. Returns what the record filter matched;
   *  `undefined` when the read failed. */
  async applyReconciled(failures: PluginLoadFailure[]): Promise<PluginMatch[] | undefined> {
    const generation = ++this.generation;
    const plugins = await this.readPlugins();
    if (plugins === undefined || generation !== this.generation) return undefined;
    this.heldFiles = new Set(plugins.map((p) => p.name.toLowerCase()));
    this.loadFailures = indexLoadFailures(failures);
    this.applyPluginFacts(plugins);
    // The record rows' own two contextValue axes, from this same read. A `.git` appearing or
    // vanishing under `mods/` is a watcher event, and that is a reconcile.
    this.records?.setImmutablePlugins(plugins.filter((p) => p.isImmutable).map((p) => p.name));
    this.records?.setTrackedPlugins(plugins.filter((p) => p.isTracked).map((p) => p.name));
    // The last scan's diagnoses describe binaries this load order may not hold.
    this.diagnoses = undefined;
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
      this.log('error', `[PluginsTreeProvider] reading the backend's plugin list failed: ${message(err)}`);
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
      this.log('warn', `[PluginsTreeProvider] the malformed-plugin scan could not be read: ${message(err)}`);
    }
  }

  // `hasMatchingRecords` only ever answers `false` while a filter is active, so no separate
  // "is a filter active" signal has to be threaded in here.
  private isHiddenByFilter(row: PluginListNode): boolean {
    const file = pluginFileOf(row);
    if (file === undefined) return false;
    return this.matches?.get(file, this.joinOrigin(file, row)) === false;
  }

  // The facts describe held copies only, and the failed copy is not one, so this joins on the
  // row's own origin rather than through `joinOrigin`.
  private loadFailureOf(row: PluginListNode): string | undefined {
    const file = pluginFileOf(row);
    if (file === undefined) return undefined;
    return this.loadFailures.get(file, row.kind === 'plugin' ? row.origin : undefined);
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
    const toIndex = this.dropIndexFor(target, names);
    if (toIndex === undefined) return;
    try {
      await this.source.reorderPlugins(names, toIndex);
    } catch (e) {
      // ADR-0019: an explicit user action failed — notify + log, then resync the
      // moved rows against disk so the tree never shows a phantom reorder.
      this.log('info', `[PluginsTreeProvider] reorderPlugins failed: ${message(e)}`);
      this.reporter?.report('error', 'Failed to reorder plugins.', message(e));
    }
    this.invalidate();
  }

  // VS Code can hand the drop a row this controller never produced, and "not one of my rows" is
  // not "past the last row" — the latter means the losing end, so a foreign row must not fall
  // through to it.
  private dropIndexFor(target: PluginsTreeNode | undefined, names: string[]): number | undefined {
    if (target !== undefined && !OWN_ROW_KINDS.has((target as { kind?: string }).kind ?? '')) return undefined;
    if (target instanceof ImplicitMasterNode) return 0;
    const targetName = target instanceof PluginNode ? target.plugin.name : undefined;
    return dropIndexForMove(this.lastOrder, names, targetName);
  }
}

// VS Code only ever passes back an element `getChildren` returned, and only these three classes
// stand for a plugins.txt line.
function isRow(element: PluginsTreeNode): element is PluginListNode {
  return element instanceof PluginNode || element instanceof ImplicitMasterNode || element instanceof EmptyNode;
}

function appendNote(item: vscode.TreeItem, note: string): void {
  item.tooltip = typeof item.tooltip === 'string' ? `${item.tooltip}\n${note}` : note;
}

function indexLoadFailures(failures: PluginLoadFailure[]): ByPluginCopy<string> {
  const byCopy = new ByPluginCopy<string>();
  for (const f of failures) byCopy.set(f.name, f.origin, f.reason);
  return byCopy;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

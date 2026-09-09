import * as vscode from 'vscode';
import { join } from 'node:path';
import type { PluginEntry } from './model';
import type { Reporter } from './deployer';
import { dropIndexForMove } from './mo2/pluginsText';
import type { ImplicitMasterSource } from './commands/plugins';
import type { Instance, InstanceValue } from './instance';

const DND_MIME = 'application/vnd.medit.pluginlist-node';

// Hoisted out of the constructor so an omitted dependency is not a fresh closure per instance.
const NO_DATA_FOLDER: () => Promise<string | undefined> = () => Promise.resolve(undefined);
const NO_IMPLICIT_MASTERS: ImplicitMasterSource = () => Promise.resolve([]);

/** The two plugins.txt gestures the tree owns, bound to the instance root and the active
 *  profile by the composition root; a refused command reaches this provider as a rejection. */
export interface PluginListSource {
  setPluginEnabled(pluginName: string, enabled: boolean): Promise<void>;
  reorderPlugins(pluginNames: string[], toIndex: number): Promise<void>;
}

/** `dataFolder` is a getter, not a settled `Promise`: the setting it resolves is editable while
 *  Modbench runs, so a value captured at construction could go stale for the provider's life. */
export interface PluginListProviderOptions {
  /** Name, origin, slot, enabled and winning for every plugin copy — the row provider's only
   *  row input (ADR-0047). */
  instance: Pick<Instance, 'value' | 'subscribe' | 'sequence'>;
  source: PluginListSource;
  log?: (msg: string) => void;
  reporter?: Reporter;
  dataFolder?: () => Promise<string | undefined>;
  /** The rows the game forces on, which only the backend can name (ADR-0021). `undefined` — it
   *  could not be reached — renders no implicit row rather than a guessed one. */
  implicitMasters?: ImplicitMasterSource;
}

/** No `resourceUri`: VS Code infers a base icon from one unless `iconPath` overrides it, so
 *  setting one would silently change every row's icon. Losing copies are registered
 *  (ADR-0044), not displayed. */
export class PluginNode extends vscode.TreeItem {
  readonly kind = 'plugin' as const;
  constructor(public readonly plugin: PluginEntry) {
    super(plugin.name, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'plugin';
    // xEdit parity: selecting a plugin node shows its File Header, with no separate affordance.
    // Routed through the `modbench.openHeader` bridge command because this provider is forbidden
    // Editing's own vocabulary, which the composition root owns instead.
    this.command = { command: 'modbench.openHeader', title: 'Open Header', arguments: [this] };
    this.checkboxState = plugin.enabled
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
  }
}

/** MO2's checked-but-disabled checkbox is not reproducible: `TreeItemCheckboxState` has no
 *  non-interactive variant, so a rendered checkbox would invite a toggle the extension must
 *  revert. A lock substitutes (ADR-0035). */
export class ImplicitMasterNode extends vscode.TreeItem {
  readonly kind = 'implicitMaster' as const;
  constructor(public readonly name: string, path?: string) {
    super(name, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'pluginImplicit';
    this.iconPath = new vscode.ThemeIcon('lock');
    this.tooltip = [name, "This plugin can't be disabled or moved (enforced by the game)."].join('\n');
    // See PluginNode's own comment above for why this routes through the modbench.openHeader
    // bridge command rather than building the header panel's target directly here.
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

// The view is shared, so a drop must be able to tell these rows from another provider's.
const OWN_ROW_KINDS = new Set<string>(['plugin', 'implicitMaster', 'empty']);

/** The plugin file a row stands for, undefined for the empty-state row. The boundary object
 *  CONTEXT-MAP.md names — the only thing about these rows anything outside Mod Management
 *  needs to know. */
export function pluginFileOf(node: PluginListNode): string | undefined {
  if (node.kind === 'plugin') return node.plugin.name;
  if (node.kind === 'implicitMaster') return node.name;
  return undefined;
}

/** Fired only from a real toggle, never a generic re-render, which carries nothing to apply.
 *  Mod Management never calls the backend, so this event is where its knowledge ends
 *  (ADR-0035). */
export interface PluginParticipationChange {
  plugin: string;
  enabled: boolean;
}

/** One row per plugins.txt line, in Plugin load order — read entirely from the Instance value
 *  (ADR-0047); this provider owns no cache or watcher over MO2's files itself. */
export class PluginListProvider
  implements vscode.TreeDataProvider<PluginListNode>, vscode.TreeDragAndDropController<PluginListNode>, vscode.Disposable
{
  readonly dropMimeTypes = [DND_MIME] as const;
  readonly dragMimeTypes = [DND_MIME] as const;

  private readonly _onDidChangeTreeData = new vscode.EventEmitter<PluginListNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  // Distinct from onDidChangeTreeData: see PluginParticipationChange.
  private readonly _onDidChangeParticipation = new vscode.EventEmitter<PluginParticipationChange>();
  readonly onDidChangeParticipation = this._onDidChangeParticipation.event;

  private readonly source: PluginListSource;
  private readonly log: (msg: string) => void;
  private readonly reporter?: Reporter;
  private readonly dataFolder: () => Promise<string | undefined>;
  private readonly implicitMasters: ImplicitMasterSource;
  private readonly instance: Pick<Instance, 'value' | 'subscribe' | 'sequence'>;
  private instanceValue: InstanceValue;
  private readonly instanceSubscription: vscode.Disposable;
  // Resolves once the Instance lands its first recompute. `sequence === 0` means "not read
  // yet", never "genuinely empty" — lets `getChildren()` await it instead of showing `EmptyNode`.
  private readonly firstValue: Promise<void>;
  private resolveFirstValue: (() => void) | undefined;
  // plugins.txt's raw file order as last rendered, so a drop computes its index against what
  // the user dragged against rather than a fresh read an external edit could skew.
  private lastOrder: string[] = [];
  private filterText = '';
  private filterLower = '';
  // Unfiltered rows, so a filter keystroke re-renders instead of re-walking the Instance value.
  // `invalidate()` clears it; `render()` leaves it intact.
  private cache?: { rows: PluginListNode[] };

  constructor(options: PluginListProviderOptions) {
    this.source = options.source;
    this.log = options.log ?? (() => {});
    this.reporter = options.reporter;
    this.dataFolder = options.dataFolder ?? NO_DATA_FOLDER;
    this.implicitMasters = options.implicitMasters ?? NO_IMPLICIT_MASTERS;
    this.instance = options.instance;
    this.instanceValue = options.instance.value;
    this.firstValue = options.instance.sequence > 0
      ? Promise.resolve()
      : new Promise((resolve) => { this.resolveFirstValue = resolve; });
    this.instanceSubscription = options.instance.subscribe((value) => {
      this.instanceValue = value;
      this.resolveFirstValue?.();
      this.invalidate();
    });
  }

  dispose(): void {
    this.instanceSubscription.dispose();
  }

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
   *  (ADR-0047 point 6). `invalidate()` here only re-renders the still-cached rows early. */
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

  getTreeItem(element: PluginListNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: PluginListNode): Promise<PluginListNode[]> {
    if (element) return []; // flat list — rows have no children
    await this.firstValue; // never claim "No plugins" before the Instance has actually read one

    if (!this.cache) {
      const built = await this.buildRows();
      if (built.kind === 'empty') return [new EmptyNode()];
      this.cache = built.cache;
    }

    // Rows here are always PluginNode/ImplicitMasterNode, both constructed with a
    // plain string label — safe to filter on directly (never TreeItemLabel/object).
    return this.filterText
      ? this.cache.rows.filter((n) => (n.label as string).toLowerCase().includes(this.filterLower))
      : this.cache.rows;
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
    // (ADR-0044) — a losing copy of the same name carries the same slot and is excluded.
    const listed = this.instanceValue.plugins
      .filter((p) => p.slot !== null && p.winning)
      .sort((a, b) => a.slot! - b.slot!);
    this.lastOrder = listed.map((p) => p.name);

    // A name in both sets renders once, as the implicit row. Display order only:
    // `this.lastOrder` stays plugins.txt's raw order, which write positions are computed against.
    const dedupedOrder = listed.filter((p) => !implicitLower.has(p.name.toLowerCase()));
    if (implicitNames.length + dedupedOrder.length === 0) return { kind: 'empty' };

    this.lastImplicitNames = implicitLower;
    const rows: PluginListNode[] = [
      ...implicitNames.map((name) => new ImplicitMasterNode(name, dataFolder ? join(dataFolder, name) : undefined)),
      ...dedupedOrder.map((p) => new PluginNode({ name: p.name, enabled: p.enabled })),
    ];
    return { kind: 'ok', cache: { rows } };
  }

  /** Lowercased, and empty before the first render. A live read, not a snapshot. */
  implicitMasterNames(): ReadonlySet<string> {
    return this.lastImplicitNames;
  }

  private lastImplicitNames: ReadonlySet<string> = new Set();

  /** VS Code passes the whole selection when the grabbed row is part of it, so `source` is the
   *  full block to move. Non-plugin rows cannot move. */
  handleDrag(
    source: readonly PluginListNode[],
    dataTransfer: vscode.DataTransfer,
    _token: vscode.CancellationToken,
  ): void {
    const names = source.filter((n): n is PluginNode => n.kind === 'plugin').map((n) => n.plugin.name);
    if (names.length === 0) return;
    dataTransfer.set(DND_MIME, new vscode.DataTransferItem({ names }));
  }

  /** The block lands before `target`, or at the end past the last row. A drop onto the implicit
   *  masters is no plugins.txt position — those rows have no line — so it lands at file
   *  index 0. */
  async handleDrop(
    target: PluginListNode | undefined,
    dataTransfer: vscode.DataTransfer,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    const payload = dataTransfer.get(DND_MIME);
    if (!payload) return;
    const { names } = payload.value as { names: string[] };
    if (names.length === 0) return;
    const toIndex = this.dropIndexFor(target, names);
    if (toIndex === undefined) return;
    try {
      await this.source.reorderPlugins(names, toIndex);
    } catch (e) {
      // ADR-0026: an explicit user action failed — notify + log, then resync the
      // moved rows against disk so the tree never shows a phantom reorder.
      const message = e instanceof Error ? e.message : String(e);
      this.log(`[PluginListProvider] reorderPlugins failed: ${message}`);
      this.reporter?.report('error', 'Failed to reorder plugins.', message);
    }
    this.invalidate();
  }

  // VS Code can hand the drop a row this controller never produced, and "not one of my rows" is
  // not "past the last row" — the latter means the losing end, so a foreign row must not fall
  // through to it.
  private dropIndexFor(target: PluginListNode | undefined, names: string[]): number | undefined {
    if (target !== undefined && !OWN_ROW_KINDS.has(target.kind)) return undefined;
    if (target?.kind === 'implicitMaster') return 0;
    const targetName = target?.kind === 'plugin' ? target.plugin.name : undefined;
    return dropIndexForMove(this.lastOrder, names, targetName);
  }
}

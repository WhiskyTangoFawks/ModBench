import * as vscode from 'vscode';
import { join } from 'node:path';
import type { IModlistSource, PluginEntry } from './model';
import type { Reporter } from './deployer';
import { dropIndexForMove } from './mo2/pluginsText';
import { buildFileConflictIndex, rootLevelFileConflicts, type ConflictEntry } from './fileConflictIndex';
import { computePluginOrderStatuses, type PluginOrderStatus } from './statusChecker';
import { resolvePluginPaths } from './explicitSession';
import { discoverImplicitMasters } from './vanillaMasters';

const DND_MIME = 'application/vnd.medit.pluginlist-node';

/** Shared resolved-undefined default for an omitted `dataFolder` — hoisted out of
 *  the constructor so it isn't a fresh closure per instance. */
const NO_DATA_FOLDER: () => Promise<string | undefined> = () => Promise.resolve(undefined);

/** Constructor options for {@link PluginListProvider}. Field order matches
 *  ModListProvider's identically-shaped options so the two siblings read the
 *  same (issue #80: replaces five positional args whose order diverged).
 *
 *  #357: `dataFolder` is a getter, not a settled `Promise` — the setting it resolves is editable
 *  while Modbench runs, so a value captured once at construction could go stale for the life of
 *  the provider. Each call re-reads through the single game-directory resolver. */
export interface PluginListProviderOptions {
  source: IModlistSource;
  log?: (msg: string) => void;
  reporter?: Reporter;
  instanceRoot?: string;
  dataFolder?: () => Promise<string | undefined>;
}

/** A single plugins.txt line, with a native checkbox mirroring its `*` (enabled)
 *  state. Toggling the checkbox writes plugins.txt immediately (wired via the
 *  view's `onDidChangeCheckboxState` handler in extension.ts). An order-aware
 *  missing-master `status` (issue #67) overlays an error icon/description/tooltip
 *  when a declared master isn't loaded before this plugin — deliberately worded
 *  distinctly from the Mods tree's presence-only "Missing master:" badge.
 *
 *  #447: `fileOverride` (this plugin filename's `ConflictEntry`, present only when more than one
 *  enabled mod provides it — see `rootLevelFileConflicts`) appends a "file override" description
 *  suffix and tooltip naming every providing mod with the winner marked, and — this is the one
 *  fact that also has to reach outside this class — sets `resourceUri` to the winner's physical
 *  path, which is what lets `FileOverrideDecorationProvider` key its badge/tint off this row.
 *  `resourceUri` is left unset for every other row (undefined `fileOverride`, exactly like today)
 *  rather than always set: VS Code infers a file-type base icon from a `resourceUri` whenever no
 *  explicit `iconPath` overrides it, so setting it unconditionally would change every uncontested
 *  row's rendered icon — a regression no unit test here could catch (`iconPath` itself would stay
 *  untouched), so it is closed by construction instead: an uncontested row never gets a
 *  resourceUri at all, the same as before this ticket. */
export class PluginNode extends vscode.TreeItem {
  readonly kind = 'plugin' as const;
  constructor(
    public readonly plugin: PluginEntry,
    public readonly orderStatus?: PluginOrderStatus,
    public readonly fileOverride?: ConflictEntry,
  ) {
    super(plugin.name, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'plugin';
    this.checkboxState = plugin.enabled
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
    if (orderStatus?.kind === 'masterNotLoadedBefore') {
      const { masters } = orderStatus;
      this.iconPath = new vscode.ThemeIcon('error');
      this.description = masters.length === 1
        ? '✗ Master not loaded before this plugin'
        : `✗ ${masters.length} masters not loaded before this plugin`;
      this.tooltip = [plugin.name, ...masters.map((m) => `Master ${m} is not loaded before this plugin`)].join('\n');
    }
    if (fileOverride) {
      this.resourceUri = vscode.Uri.file(fileOverride.winner);
      // Appended (never overwrites) so the order-aware badge above and this decoration can
      // legitimately coexist on the same row (#447 AC3 — the Missing-master badge is unaffected).
      this.description = [this.description, `${fileOverride.providers.length} mods`].filter(Boolean).join(' ');
      const overrideLines = [
        `File override: ${fileOverride.providers.length} mods provide this plugin — winner: ${fileOverride.winnerMod}`,
        ...fileOverride.providers.map((p) => p === fileOverride.winnerMod ? `${p} (winner)` : p),
      ];
      this.tooltip = typeof this.tooltip === 'string'
        ? `${this.tooltip}\n${overrideLines.join('\n')}`
        : [plugin.name, ...overrideLines].join('\n');
    }
  }
}

/** This row's order-aware badge's flagged master names, or undefined when it carries none
 *  (#277 / ADR-0037 AC8) — the composite's structured access to what `PluginNode`'s constructor
 *  above otherwise only bakes into rendered icon/description/tooltip text, so the session-aware
 *  reconciliation there can dedupe by master name without parsing that text. */
export function orderIssueMastersOf(node: PluginListNode): string[] | undefined {
  return node.kind === 'plugin' && node.orderStatus?.kind === 'masterNotLoadedBefore'
    ? node.orderStatus.masters
    : undefined;
}

/** A synthetic row for one of the game's implicitly-loaded vanilla/DLC masters
 *  (issue #108) — discovered from the resolved Data folder (a plugin file that
 *  is NOT a hardlink), never hardcoded. Rendered ahead of plugins.txt's own
 *  rows, in topological order. No checkbox (unset, so VS Code renders none —
 *  nothing to toggle), and excluded from drag by `handleDrag`'s existing
 *  `kind === 'plugin'` filter (not draggable). Its `contextValue`
 *  (`pluginImplicit`, distinct from `plugin`) lets package.json menu `when`
 *  clauses hide any plugin-only command (reorder, toggle) for it.
 *
 *  #276 / ADR-0035: the leading slot answers exactly one question — "can you
 *  change whether this loads?" — so this row (forced on, can't be toggled or
 *  moved) renders a lock where a togglable row renders a checkbox, adopting
 *  MO2's own `forceLoaded` wording verbatim (`pluginlist.cpp`) rather than
 *  inventing new copy. MO2 itself renders this case as a checked-but-disabled
 *  checkbox plus grayed name text, not a lock — that's not reproducible here:
 *  `vscode.TreeItemCheckboxState` is `Checked`/`Unchecked` only, with no
 *  non-interactive variant, so a rendered checkbox is always clickable and a
 *  forced-on row would invite a toggle the extension would have to silently
 *  revert. A lock is the platform-forced substitute for the icon only; the
 *  label-graying MO2 also does *is* reproducible (`resourceUri` +
 *  `FileDecorationProvider`, same pattern as `HiddenDownloadDecorationProvider`)
 *  and is wired separately via `ImplicitMasterDecorationProvider`, keyed off
 *  the `resourceUri` this constructor sets when given a resolved path. */
export class ImplicitMasterNode extends vscode.TreeItem {
  readonly kind = 'implicitMaster' as const;
  constructor(public readonly name: string, path?: string) {
    super(name, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'pluginImplicit';
    this.iconPath = new vscode.ThemeIcon('lock');
    this.tooltip = [name, "This plugin can't be disabled or moved (enforced by the game)."].join('\n');
    if (path !== undefined) this.resourceUri = vscode.Uri.file(path);
  }
}

/** Inline error surface: shown instead of an empty list when the plugins.txt
 *  read fails, so a failure is never indistinguishable from "no plugins"
 *  (ADR-0026, modmanager/CLAUDE.md convention). */
export class ErrorNode extends vscode.TreeItem {
  readonly kind = 'error' as const;
  constructor(message: string) {
    super(`⚠ Failed to load: ${message}`, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'error';
    this.tooltip = message;
    this.iconPath = new vscode.ThemeIcon('error');
  }
}

/** Empty state: a single informational row when plugins.txt has no lines. */
export class EmptyNode extends vscode.TreeItem {
  readonly kind = 'empty' as const;
  constructor() {
    super('No plugins', vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon('check');
  }
}

export type PluginListNode = PluginNode | ImplicitMasterNode | ErrorNode | EmptyNode;

/** The `kind`s this provider produces — see `handleDrop`, which has to tell its own rows from a
 *  row some other provider contributed to the same view (#270). */
const OWN_ROW_KINDS = new Set<string>(['plugin', 'implicitMaster', 'error', 'empty']);

/** The plugin file a row stands for, or undefined when the row stands for no file (the error and
 *  empty-state rows). #270: this is what the merged Plugins tree's composite asks a row for — the
 *  boundary object CONTEXT-MAP.md names, and the only thing about these rows anything outside
 *  Mod Management needs to know. Kept here, next to the node classes, so no caller has to
 *  destructure them. */
export function pluginFileOf(node: PluginListNode): string | undefined {
  if (node.kind === 'plugin') return node.plugin.name;
  if (node.kind === 'implicitMaster') return node.name;
  return undefined;
}

/** Structural guard for "is this row shaped like one of ours" — checked by `kind` alone against
 *  `OWN_ROW_KINDS`, never by importing Editing's row types, so this file's "imports nothing from
 *  Editing" boundary (`src/test/contextBoundary.test.ts`) holds without needing to know what a
 *  non-plugin row *is*, only that it isn't one of these four. */
function isPluginListNode(node: unknown): node is PluginListNode {
  if (typeof node !== 'object' || node === null || !('kind' in node)) return false;
  return OWN_ROW_KINDS.has((node as { kind: string }).kind);
}

/** #363: Filter to Selected Plugins' own selection-extractor — the clicked row plus its
 *  multi-selection (VS Code's `view/item/context` invocation shape, `(clicked, selected[])`),
 *  collapsed to the deduped plugin-name set the command scopes its Editing-side narrowing to.
 *  Mirrors `DownloadsPanel.ts`'s own `selectionNames`: falls back to the clicked row alone when
 *  no selection array is supplied.
 *
 *  `selected` is deliberately untyped beyond `unknown[]` — the merged Plugins tree's selection can
 *  hold Editing's own child rows too, and this drops every one of them rather than import their
 *  shape: `isPluginListNode` only ever asks "is this one of the four rows Mod Management owns",
 *  never what an Editing row is instead. That is #363's own, deliberate divergence from xEdit's
 *  `mniNavFilterApplySelected` (`xeMainForm.pas:13976-14027`), which resolves a selected *element*
 *  up to its owning file — not reproducible here without importing Editing's row types into Mod
 *  Management, which the bounded-context split forbids. In practice the drop only ever manifests
 *  in a mixed selection: the `view/item/context` `when` clause only offers this command on a
 *  plugin row to begin with. */
export function pluginNamesInSelection(clicked: PluginListNode | undefined, selected: unknown[] | undefined): string[] {
  const nodes = selected && selected.length > 0 ? selected : (clicked ? [clicked] : []);
  const names = nodes.filter(isPluginListNode).map(pluginFileOf).filter((n): n is string => n !== undefined);
  return [...new Set(names)];
}

/** Sidebar Plugin List (Loadout) tree: one row per plugins.txt line, in Plugin
 *  load order (top = loads first). Toggling a row's checkbox writes plugins.txt
 *  immediately via `setPluginEnabled`. */
export class PluginListProvider
  implements vscode.TreeDataProvider<PluginListNode>, vscode.TreeDragAndDropController<PluginListNode>
{
  readonly dropMimeTypes = [DND_MIME] as const;
  readonly dragMimeTypes = [DND_MIME] as const;

  private readonly _onDidChangeTreeData = new vscode.EventEmitter<PluginListNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly source: IModlistSource;
  private readonly log: (msg: string) => void;
  private readonly reporter?: Reporter;
  private readonly instanceRoot?: string;
  private readonly dataFolder: () => Promise<string | undefined>;
  /** The last rendered plugin order, so a drop computes its index against exactly
   *  what the user dragged against (not a fresh read that an external edit could skew).
   *  A separate concern from `cache` below — this is plugins.txt's raw file order
   *  (what drop-index math writes against), not the full display row set. */
  private lastOrder: string[] = [];
  /** Active title-bar filter (case-insensitive substring on plugin name); empty = off. */
  private filterText = '';
  private filterLower = '';
  /** Issue #79: caches the unfiltered computed row list (implicit masters +
   *  PluginNodes with badges) so a filter keystroke re-renders instead of
   *  re-reading plugins.txt / re-walking the conflict index and status pass.
   *  `invalidate()` clears it; `render()` (setFilter) leaves it intact. */
  private cache?: { rows: PluginListNode[] };

  /** `instanceRoot`, when provided, enables the order-aware missing-master badge
   *  (issue #67): each plugin's declared masters are read and checked against the
   *  Plugin load order. Omitted in tests using an in-memory-only source.
   *  `dataFolder` reads the game's resolved Data folder through the single
   *  game-directory resolver (#357) — for locating vanilla/DLC/CC plugins no mod
   *  ships; an undefined resolution degrades those lookups. */
  constructor(options: PluginListProviderOptions) {
    this.source = options.source;
    this.log = options.log ?? (() => {});
    this.reporter = options.reporter;
    this.instanceRoot = options.instanceRoot;
    this.dataFolder = options.dataFolder ?? NO_DATA_FOLDER;
  }

  /** Clears the cached row set and re-renders — a mutation (toggle, drop, ...)
   *  invalidated what's on disk, so the next `getChildren()` must re-read
   *  plugins.txt/enabled state. Also the title-bar Refresh button's action.
   *  Issue #79: distinct from `render()`, which only re-renders already-built rows. */
  invalidate(): void {
    this.cache = undefined;
    this._onDidChangeTreeData.fire(undefined);
  }

  /** Re-renders already-built rows without touching the cache. Issue #79: the
   *  only call site is `setFilter` — a filter keystroke never changes what's on
   *  disk, so it must not force a re-read of plugins.txt/enabled state. */
  private render(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  /** Set the title-bar filter (empty string clears it) and re-render. Narrows the
   *  rendered rows to plugins whose name contains `text`, case-insensitively —
   *  the same transient-InputBox pattern used across every Modbench list surface.
   *  Render-only (#79): the filter narrows which already-built rows show — it
   *  never invalidates the cache. */
  setFilter(text: string): void {
    this.filterText = text;
    this.filterLower = text.toLowerCase();
    this.render();
  }

  /** Toggle a plugin's `*` (enabled) state, writing plugins.txt immediately, then
   *  invalidate so the tree re-reads the persisted state. */
  async setPluginEnabled(pluginName: string, enabled: boolean): Promise<void> {
    await this.source.setPluginEnabled(pluginName, enabled);
    this.invalidate();
  }

  /** Resolve a plugin NAME to its winning physical path — the MO2-priority
   *  FileConflictIndex winner for a mod-provided plugin, else the game's Data
   *  folder for an unmanaged vanilla/DLC/CC plugin (the same resolution the
   *  editing-session builder performs via `resolvePluginPaths`). Used by the
   *  Reveal in Explorer row action (issue #69). Returns undefined when no
   *  instanceRoot is configured or resolution fails (ini/index unreadable) — a
   *  fresh read each call, since reveal is a rare explicit action. */
  async resolvePluginPath(name: string): Promise<string | undefined> {
    if (!this.instanceRoot) return undefined;
    try {
      const entries = await this.source.readModlist();
      const index = await buildFileConflictIndex(entries, this.instanceRoot, this.log);
      const dataFolder = await this.dataFolder();
      if (!dataFolder) return undefined;
      return resolvePluginPaths([name], index, dataFolder).get(name);
    } catch (e) {
      this.log(`[PluginListProvider] resolvePluginPath("${name}") failed: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    }
  }

  getTreeItem(element: PluginListNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: PluginListNode): Promise<PluginListNode[]> {
    if (element) return []; // flat list — rows have no children

    if (!this.cache) {
      const built = await this.buildRows();
      if (built.kind === 'error') return [new ErrorNode(built.message)];
      if (built.kind === 'empty') return [new EmptyNode()];
      this.cache = built.cache;
    }

    // Rows here are always PluginNode/ImplicitMasterNode, both constructed with a
    // plain string label — safe to filter on directly (never TreeItemLabel/object).
    return this.filterText
      ? this.cache.rows.filter((n) => (n.label as string).toLowerCase().includes(this.filterLower))
      : this.cache.rows;
  }

  /** Reads plugins.txt/enabled state and computes the full unfiltered row set
   *  (issue #79: the cache-population path, run only on a cache miss). Returns a
   *  discriminated result rather than caching an error/empty placeholder, so a
   *  transient read failure or a momentarily-empty plugins.txt never sticks
   *  around as stale cached state. */
  private async buildRows(): Promise<
    | { kind: 'error'; message: string }
    | { kind: 'empty' }
    | { kind: 'ok'; cache: { rows: PluginListNode[] } }
  > {
    let order: string[];
    let enabled: string[];
    try {
      [order, enabled] = await Promise.all([
        this.source.readPluginOrder(),
        this.source.readEnabledPlugins(),
      ]);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.log(`[PluginListProvider] readPluginOrder failed: ${message}`);
      return { kind: 'error', message };
    }

    this.lastOrder = order;

    // The game's implicitly-loaded vanilla/DLC masters (issue #108): discovered from
    // the resolved Data folder, never from plugins.txt. Rendered first, forced on — can't be
    // toggled or moved (#276). A name in both sets renders exactly once — as the implicit row — so its
    // plugins.txt line (if any, e.g. a stale CC .esl entry) is filtered out here.
    // `fullOrder` (implicit-first) is used for row rendering and badge computation
    // ONLY; `this.lastOrder` above stays plugins.txt's raw order, since that's what
    // `dropIndexForMove`/`reorderPlugins` write positions against.
    const dataFolder = await this.dataFolder();
    const implicitNames = await discoverImplicitMasters(dataFolder, this.log);
    const implicitLower = new Set(implicitNames.map((n) => n.toLowerCase()));
    const dedupedOrder = order.filter((n) => !implicitLower.has(n.toLowerCase()));
    const fullOrder = [...implicitNames, ...dedupedOrder];

    if (fullOrder.length === 0) return { kind: 'empty' };
    const enabledSet = new Set(enabled);
    // Badges are computed against the full order (never the filtered subset) so a
    // filtered-out master still counts toward a visible row's order-aware verdict.
    const facts = await this.computeRowFacts(fullOrder);
    this.lastImplicitNames = new Set(implicitNames.map((n) => n.toLowerCase()));
    this.lastFileOverrides = facts?.fileOverrides ?? new Map();
    const rows: PluginListNode[] = [
      ...implicitNames.map((name) => new ImplicitMasterNode(name, dataFolder ? join(dataFolder, name) : undefined)),
      ...dedupedOrder.map((name) => new PluginNode(
        { name, enabled: enabledSet.has(name) },
        facts?.statuses.get(name),
        facts?.fileOverrides.get(name.toLowerCase()),
      )),
    ];
    return { kind: 'ok', cache: { rows } };
  }

  /** The lowercased implicit-master names from the last render (#276) — what
   *  `ImplicitMasterDecorationProvider` matches a `resourceUri` against to gray an
   *  implicit master's label the way MO2 grays `COL_NAME` for a `forceLoaded` row. Empty
   *  before the first render; a live read (not a snapshot), same convention as
   *  `DownloadsProvider.hiddenNames()`. */
  implicitMasterNames(): ReadonlySet<string> {
    return this.lastImplicitNames;
  }

  private lastImplicitNames: ReadonlySet<string> = new Set();

  /** #447: every root-level (plugin) `ConflictEntry` more than one enabled mod currently
   *  provides, from the last render, keyed by lowercased plugin filename — what
   *  `FileOverrideDecorationProvider` matches a row's `resourceUri` against for its badge/tint,
   *  and (for #448) the signal a plugin's row has peers to expand into a Stack node from. Empty
   *  before the first render; a live read (not a snapshot), same convention as
   *  `implicitMasterNames()`. */
  fileOverrides(): ReadonlyMap<string, ConflictEntry> {
    return this.lastFileOverrides;
  }

  private lastFileOverrides: ReadonlyMap<string, ConflictEntry> = new Map();

  /** Order-aware missing-master verdicts *and* (#447) file-override facts for `order` (the
   *  implicit-first, deduped full row order — see `getChildren`), or undefined when no
   *  instanceRoot is configured. One `FileConflictIndex` build feeds both — they are two
   *  different views over the same enabled-mod file walk, not two separate ones. A secondary,
   *  non-blocking step (modmanager/CLAUDE.md): on any failure both badges degrade to absent —
   *  the tree still renders every row — with a warning surfaced (ADR-0026: silently missing
   *  badges would look identical to "nothing to flag"). */
  private async computeRowFacts(order: string[]): Promise<
    { statuses: Map<string, PluginOrderStatus>; fileOverrides: Map<string, ConflictEntry> } | undefined
  > {
    if (!this.instanceRoot) return undefined;
    try {
      const entries = await this.source.readModlist();
      const index = await buildFileConflictIndex(entries, this.instanceRoot, this.log);
      const dataFolder = await this.dataFolder();
      const statuses = await computePluginOrderStatuses(order, index, dataFolder, this.log);
      return { statuses, fileOverrides: rootLevelFileConflicts(index) };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.log(`[PluginListProvider] master-order status computation failed: ${message}`);
      this.reporter?.report('warning', 'Could not compute plugin master-order status — badges may be inaccurate.', message);
      return undefined;
    }
  }

  /** Serialise the dragged selection. VS Code passes the whole selection when the
   *  grabbed row is part of it (an unselected grab collapses to a single-item
   *  selection), so `source` is the full block to move. Non-plugin rows can't move. */
  handleDrag(
    source: readonly PluginListNode[],
    dataTransfer: vscode.DataTransfer,
    _token: vscode.CancellationToken,
  ): void {
    const names = source.filter((n): n is PluginNode => n.kind === 'plugin').map((n) => n.plugin.name);
    if (names.length === 0) return;
    dataTransfer.set(DND_MIME, new vscode.DataTransferItem({ names }));
  }

  /** Move the dragged block so it lands before `target` (or at the end when the
   *  drop is past the last row / onto a non-plugin node), writing plugins.txt
   *  immediately. `dropIndexForMove` reconciles the drop target with
   *  `movePluginsInText`'s post-removal index convention. A drop onto the
   *  undraggable implicit-master block (issue #108) is not a plugins.txt position —
   *  those rows have no line — so it lands at file-index 0, the top of the
   *  reorderable region, computed against `this.lastOrder` (plugins.txt's raw order,
   *  NEVER the display-composed implicit-first order — writing against the
   *  wrong index would corrupt plugins.txt). */
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

  /** The plugins.txt index the dragged block should land at, or undefined when the drop is not a
   *  position at all and must be refused.
   *
   *  #270 makes that distinction load-bearing. This view's rows have children now, so VS Code can
   *  hand the drop a row this controller never produced, and "not one of my rows" is not the same
   *  as "past the last row" — the latter legitimately means the end of the load order, so letting
   *  a foreign row fall through to it would silently move the dragged plugins to the bottom of
   *  plugins.txt. The provider stays ignorant of what those other rows *are*; it only knows which
   *  kinds are its own. */
  private dropIndexFor(target: PluginListNode | undefined, names: string[]): number | undefined {
    if (target !== undefined && !OWN_ROW_KINDS.has(target.kind)) return undefined;
    if (target?.kind === 'implicitMaster') return 0;
    const targetName = target?.kind === 'plugin' ? target.plugin.name : undefined;
    return dropIndexForMove(this.lastOrder, names, targetName);
  }
}

import * as vscode from 'vscode';
import { OVERWRITE_DIR_NAME, type Mod, type ModlistEntry, type Separator } from '../instanceLoader/instance';
import { groupModlist, type ModlistTree } from './modlistTree';
import type { ModStatus, ModStatusResult } from '../instanceLoader/statusChecker';
import type { InstanceValue, InstanceView } from '../instanceLoader/instance';
import { firstReadOf, type FirstRead } from './instanceFirstRead';
import { ErrorNode } from './errorNode';
import { dropMove, type DraggedRows } from './moveDrop';
import { setModsEnabled as setModsEnabledCommand } from '../modlist/modlist';

/** CONTEXT.md, Sort direction: which end of mod order the view shows at the top. */
export type SortDirection = 'losingAtTop' | 'winningAtTop';

const DND_MIME = 'application/vnd.medit.modlist-node';

/** The pinned Overwrite row's kind and `contextValue`, which package.json's `when` clauses match
 *  on: the row stands for MO2's folder, so it is named as the value names that folder. */
export const OVERWRITE_NODE_KIND = OVERWRITE_DIR_NAME;

// `DataTransferItem.value` is `any` — handleDrag, below, is this provider's only writer of it.
function isDraggedRows(value: unknown): value is DraggedRows {
  if (typeof value !== 'object' || value === null || !('rows' in value) || !Array.isArray(value.rows)) return false;
  return value.rows.every((row) => row instanceof ModNode || row instanceof SeparatorNode);
}

export interface ModListProviderOptions {
  /** Mods/separators in override order, per-mod conflict/override/missing status and the
   *  overwrite/ file count — the tree's only data input (ADR-0015). */
  instance: InstanceView;
  /** The instance the check box command writes to; never read by this provider. */
  instanceRoot: string;
}

function statusIconId(status?: ModStatusResult): string {
  switch (status?.status.kind) {
    case 'conflicts':
    case 'overrides':
      return 'warning';
    case 'ok':
    case undefined:
      return 'package';
  }
}

function statusLabel(status: ModStatus): string {
  switch (status.kind) {
    case 'conflicts': return `⚠ ${status.count} conflicts`;
    case 'overrides': return `⚠ Overrides ${status.count}`;
    case 'ok': return '';
  }
}

// Selection and expansion follow a row across a change on disk, and a mod and a separator may
// share a name.
function rowIdentity(kind: 'mod' | 'separator', name: string): string {
  return `${kind}:${name}`;
}

// A space-separated flag string, matching `downloadContextValue`'s own pattern: package.json's
// `when` clauses match a flag with `viewItem =~ /\bflag\b/`.
function modContextValue(mod: Pick<Mod, 'nexusId' | 'enabled'>): string {
  const flags = [mod.nexusId !== undefined && 'hasNexus', mod.enabled ? 'enabled' : 'disabled'];
  return ['mod', ...flags.filter((f): f is string => f !== false)].join(' ');
}

/** A separator and the mods it shows: every mod it holds, or only the matching ones when a filter
 *  shows it for them, and then it opens on its own. */
export class SeparatorNode extends vscode.TreeItem {
  readonly kind = 'separator' as const;
  constructor(
    public readonly separator: Separator,
    public readonly mods: Mod[],
    shown: 'allMods' | 'matchingMods' = 'allMods',
  ) {
    super(separator.name, separatorExpander(mods, shown));
    this.id = rowIdentity(this.kind, separator.name);
    this.contextValue = 'separator';
  }
}

function separatorExpander(mods: readonly Mod[], shown: 'allMods' | 'matchingMods'): vscode.TreeItemCollapsibleState {
  if (mods.length === 0) return vscode.TreeItemCollapsibleState.None;
  return shown === 'matchingMods' ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;
}

/** A non-'ok' status overlays a badge onto the icon, description, and tooltip. */
export class ModNode extends vscode.TreeItem {
  readonly kind = 'mod' as const;
  readonly nexusModId: string | undefined;
  constructor(public readonly mod: Mod, status?: ModStatusResult) {
    super(mod.name, vscode.TreeItemCollapsibleState.None);
    this.id = rowIdentity(this.kind, mod.name);
    this.nexusModId = mod.nexusId;
    const baseTooltip = [mod.name, mod.version, mod.nexusId, mod.archiveFilename]
      .filter((s): s is string => !!s)
      .join(' · ');
    this.description = mod.version ?? '';
    this.tooltip = baseTooltip;
    this.iconPath = new vscode.ThemeIcon(statusIconId(status));
    if (status && status.status.kind !== 'ok') {
      const label = statusLabel(status.status);
      this.description = [this.description, label].filter(Boolean).join(' ');
      this.tooltip = [baseTooltip, label, ...status.conflictLines].filter(Boolean).join('\n');
    }
    this.contextValue = modContextValue(mod);
    this.checkboxState = mod.enabled
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
  }
}

/** Pinned leaf over the instance's `overwrite/` folder. Not a modlist.txt entry, so it has no
 *  check box and no drag, and no resourceUri, which would let a file decoration tint its label. */
export class OverwriteNode extends vscode.TreeItem {
  readonly kind = OVERWRITE_NODE_KIND;
  constructor(fileCount: number) {
    super('Overwrite', vscode.TreeItemCollapsibleState.None);
    this.id = this.kind;
    this.contextValue = OVERWRITE_NODE_KIND;
    if (fileCount > 0) this.description = fileCount.toLocaleString();
    this.iconPath = fileCount > 0
      ? new vscode.ThemeIcon('folder', new vscode.ThemeColor('charts.red'))
      : new vscode.ThemeIcon('folder');
    this.tooltip = 'The files tools wrote while MO2 ran them, which win over every mod.';
  }
}

export type ModlistNode = SeparatorNode | ModNode | OverwriteNode | ErrorNode;

export const NO_MODS_MESSAGE =
  'No mods or separators. Install Mod… or Create Empty Mod…, in the title bar\'s overflow menu, adds one.';

function isEntryNode(node: ModlistNode): node is ModNode | SeparatorNode {
  return node.kind === 'mod' || node.kind === 'separator';
}

/** Sidebar Mods tree over an MO2 instance's active profile — rows, statuses and
 *  the overwrite count all read entirely from the Instance value (ADR-0015); this provider owns
 *  no cache or watcher over MO2's files itself. */
export class ModListProvider
  implements vscode.TreeDataProvider<ModlistNode>, vscode.TreeDragAndDropController<ModlistNode>, vscode.Disposable
{
  readonly dropMimeTypes = [DND_MIME] as const;
  readonly dragMimeTypes = [DND_MIME] as const;

  private readonly _onDidChangeTreeData = new vscode.EventEmitter<ModlistNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private tree?: ModlistTree;
  private readonly parents = new WeakMap<ModNode, SeparatorNode>();
  private cachedEntries?: ModlistEntry[];
  private filterText = '';
  private filterLower = '';
  private groupingOn = true;
  private direction: SortDirection = 'losingAtTop';
  private readonly instanceRoot: string;
  private readonly instance: InstanceView;
  private instanceValue: InstanceValue;
  private readonly instanceSubscription: vscode.Disposable;
  private readonly firstRead: FirstRead;

  constructor(options: ModListProviderOptions) {
    this.instanceRoot = options.instanceRoot;
    this.instance = options.instance;
    this.instanceValue = options.instance.value;
    this.firstRead = firstReadOf(options.instance);
    this.instanceSubscription = options.instance.subscribe((value) => {
      this.instanceValue = value;
      this.invalidate();
    });
  }

  dispose(): void {
    this.instanceSubscription.dispose();
    this.firstRead.dispose();
  }

  /** Re-pulls `instance.value` rather than trusting the copy the last subscriber callback left:
   *  a check box whose write failed returns to whatever the Instance is currently holding, not a
   *  snapshot that predates it. */
  invalidate(): void {
    this.instanceValue = this.instance.value;
    this.tree = undefined;
    this.cachedEntries = undefined;
    this._onDidChangeTreeData.fire(undefined);
  }

  private render(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  /** Render-only: a filter keystroke narrows already-built rows and never re-reads the value. */
  setFilter(text: string, grouping: boolean): void {
    this.filterText = text;
    this.filterLower = text.toLowerCase();
    this.groupingOn = text === '' ? true : grouping;
    this.render();
  }

  /** The enabled mods over the listed mods, whatever the filter shows. */
  description(): string | undefined {
    if (this.instance.sequence === 0) return undefined;
    const { activeCount, installedCount } = this.ensureLoaded();
    return `${activeCount} / ${installedCount}`;
  }

  /** A row the view still holds may predate the value, so its mod's state is read from the value. */
  isEnabled(row: ModNode): boolean {
    const entry = this.instanceValue.mods.find((m) => m.kind === 'mod' && m.name === row.mod.name);
    return entry?.enabled ?? row.mod.enabled;
  }

  /** The view's message line while no filter is active. Overwrite is always a row, so an empty
   *  list says so here, above it. */
  emptyListMessage(): string | undefined {
    if (this.instance.sequence === 0 || this.instanceValue.mods.length > 0) return undefined;
    return NO_MODS_MESSAGE;
  }

  // No stable API names the focused row. VS Code appends the row a click selects to the selection
  // it drags, so the last row stands in for it.
  handleDrag(
    source: readonly ModlistNode[],
    dataTransfer: vscode.DataTransfer,
    _token: vscode.CancellationToken,
  ): void {
    const rows = source.filter(isEntryNode);
    if (rows.length === 0) return;
    const dragged: DraggedRows = { rows, focused: rows.at(-1) };
    dataTransfer.set(DND_MIME, new vscode.DataTransferItem(dragged));
  }

  // An entry point to move: it fires the gesture and uses no result, and the watch brings the
  // write back to the view (commands.md, Entry points are not gestures).
  async handleDrop(
    target: ModlistNode | undefined,
    dataTransfer: vscode.DataTransfer,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    const payload = dataTransfer.get(DND_MIME);
    if (!payload || !isDraggedRows(payload.value)) return;
    const move = dropMove(payload.value, target, this.direction);
    if (!move) return;
    await vscode.commands.executeCommand('modbench.mod.move', move.argument[0], move.argument, move.target);
  }


  getTreeItem(element: ModlistNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: ModlistNode): Promise<ModlistNode[]> {
    if (element instanceof SeparatorNode) return this.separatorChildren(element);
    if (element) return [];
    await this.firstRead.settled; // never render before the Instance has actually read once
    if (this.firstRead.failure !== undefined) return [new ErrorNode(this.firstRead.failure)];

    const tree = this.ensureLoaded();
    const { ungrouped, separators } = this.entryRoots(tree);
    const overwrite = this.overwriteNode();
    return this.direction === 'winningAtTop'
      ? [overwrite, ...[...separators].reverse(), ...[...ungrouped].reverse()]
      : [...ungrouped, ...separators, overwrite];
  }

  private ensureLoaded(): ModlistTree {
    if (!this.tree) {
      this.cachedEntries = [...this.instanceValue.mods];
      this.tree = groupModlist(this.cachedEntries);
    }
    return this.tree;
  }

  // The roots other than Overwrite, losing end first: the ungrouped mods, which sit below every
  // separator in mod order, and then the separators. The flat list is all ungrouped.
  private entryRoots(tree: ModlistTree): { ungrouped: ModlistNode[]; separators: ModlistNode[] } {
    const ungrouped = this.losingFirst(tree.ungrouped);
    const groups = [...tree.groups].reverse();
    if (this.filterText && !this.groupingOn) {
      const flat = [...ungrouped, ...groups.flatMap((g) => this.losingFirst(g.mods))];
      return { ungrouped: flat.filter((m) => this.matches(m.name)).map(this.toModNode), separators: [] };
    }
    if (!this.filterText) {
      return {
        ungrouped: ungrouped.map(this.toModNode),
        separators: groups.map((g) => new SeparatorNode(g.separator, this.inViewOrder(g.mods))),
      };
    }
    const separators: ModlistNode[] = [];
    for (const g of groups) {
      if (this.matches(g.separator.name)) {
        separators.push(new SeparatorNode(g.separator, this.inViewOrder(g.mods)));
        continue;
      }
      const matchingMods = g.mods.filter((m) => this.matches(m.name));
      if (matchingMods.length > 0) {
        separators.push(new SeparatorNode(g.separator, this.inViewOrder(matchingMods), 'matchingMods'));
      }
    }
    return { ungrouped: ungrouped.filter((m) => this.matches(m.name)).map(this.toModNode), separators };
  }

  private overwriteNode(): OverwriteNode {
    return new OverwriteNode(this.instanceValue.overwriteFileCount);
  }

  private toModNode = (m: Mod): ModNode => new ModNode(m, this.instanceValue.modStatuses.get(m.name));

  private separatorChildren(element: SeparatorNode): ModlistNode[] {
    return element.mods.map((m) => {
      const row = this.toModNode(m);
      this.parents.set(row, element);
      return row;
    });
  }

  getParent(element: ModlistNode): SeparatorNode | undefined {
    return element instanceof ModNode ? this.parents.get(element) : undefined;
  }

  // modlist.txt is winning-first. View order only.
  private losingFirst(mods: readonly Mod[]): Mod[] {
    return [...mods].reverse();
  }

  private inViewOrder(mods: readonly Mod[]): Mod[] {
    return this.direction === 'winningAtTop' ? [...mods] : this.losingFirst(mods);
  }

  private matches(name: string): boolean {
    return name.toLowerCase().includes(this.filterLower);
  }

  // The check box is an entry point to the same command a context menu click or key reaches
  // (mods.md, Menus and keys): one mod through the same `setModsEnabled`.
  async setModEnabled(modName: string, enabled: boolean): Promise<void> {
    const profile = this.instanceValue.activeProfile;
    const result = await setModsEnabledCommand(this.instanceRoot, profile, [modName], enabled);
    if (!result.applied) throw new Error(result.refusal);
    const refusal = result.outcome.refused[0];
    if (refusal) throw new Error(refusal.reason);
  }

  viewDirection(): SortDirection {
    return this.direction;
  }

  /** Presentation only — never changes which mod wins a conflict. */
  setViewDirection(direction: SortDirection): void {
    this.direction = direction;
    this.invalidate();
  }
}

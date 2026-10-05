import * as vscode from 'vscode';
import type { FileOrigin, Mod, OriginFile, ModlistEntry, OriginFolder, Separator } from '../instanceLoader/instance';
import { fileOrderConflictOf, modOrigin, OVERWRITE_LABEL, RUNTIME_OUTPUT } from '../instanceLoader/fileConflictIndex';
import { OVERWRITE_ORIGIN } from '../instanceLoader/loadOrderSnapshot';
import { groupModlist, type ModlistGroup, type ModlistTree } from './modlistTree';
import { lastGoodReadMessage, type InstanceValue, type InstanceView } from '../instanceLoader/instance';
import { firstReadOf, type FirstRead } from '../drivingLib/instanceFirstRead';
import { ErrorNode } from '../drivingLib/errorNode';
import { dropMove, type DraggedRows } from './moveDrop';
import {
  anyNamed, expanderOver, filesIn, narrowToMatches, shownUnder, FileNode, FolderNode,
  type ChildrenShown,
} from './modFiles';
import { modRowUri } from './modIndicators';
import { filesInConflict } from './conflictTable';
import type { SortDirection } from '../drivingLib/sortDirectionToggle';

const DND_MIME = 'application/vnd.medit.modlist-node';

// `DataTransferItem.value` is `any` — handleDrag, below, is this provider's only writer of it.
function isDraggedRows(value: unknown): value is DraggedRows {
  if (typeof value !== 'object' || value === null || !('rows' in value) || !Array.isArray(value.rows)) return false;
  return value.rows.every((row) => row instanceof ModNode || row instanceof SeparatorNode);
}

export interface ModListProviderOptions {
  /** Mods/separators in override order, per-mod conflict/override/missing status and the
   *  overwrite/ file count. */
  instance: InstanceView;
}

// Selection and expansion follow a row across a change on disk, and a mod and a separator may
// share a name.
function rowIdentity(kind: 'mod' | 'separator', name: string): string {
  return `${kind}:${name}`;
}

// A space-separated flag string, matching `downloadContextValue`'s own pattern: package.json's
// `when` clauses match a flag with `viewItem =~ /\bflag\b/`.
function modContextValue(mod: Pick<Mod, 'nexusId' | 'enabled'>, facts: ModFacts | undefined): string {
  const flags = [
    mod.nexusId !== undefined && 'hasNexus', mod.enabled ? 'enabled' : 'disabled',
    facts?.holdsPlugin === true && 'holdsPlugin', facts?.tracked === false && 'untracked',
    facts?.fileOrderConflict === true && 'fileOrderConflict',
  ];
  return ['mod', ...flags.filter((f): f is string => f !== false)].join(' ');
}

/** What the instance value says of a mod beyond its entry: whether it holds a plugin, whether its
 *  folder holds a repository, and whether it has a file order conflict. */
export interface ModFacts {
  readonly holdsPlugin: boolean;
  readonly tracked: boolean;
  readonly fileOrderConflict: boolean;
}

/** A separator and the mods it shows: every mod it holds, or only the matching ones when a filter
 *  shows it for them, and then it opens on its own. */
export class SeparatorNode extends vscode.TreeItem {
  readonly kind = 'separator' as const;
  constructor(
    public readonly separator: Separator,
    public readonly mods: Mod[],
    public readonly shown: ChildrenShown = 'all',
  ) {
    super(separator.name, expanderOver(mods, shown));
    this.id = rowIdentity(this.kind, separator.name);
    this.contextValue = 'separator';
  }
}

export class ModNode extends vscode.TreeItem {
  readonly kind = 'mod' as const;
  readonly nexusModId: string | undefined;
  constructor(
    public readonly mod: Mod, public readonly facts?: ModFacts,
    public readonly files: readonly OriginFile[] = [],
    public readonly folders: readonly OriginFolder[] = [],
    public readonly shown: ChildrenShown = 'all',
  ) {
    super(mod.name, expanderOver([...files, ...folders], shown));
    this.id = rowIdentity(this.kind, mod.name);
    this.resourceUri = modRowUri(mod.name);
    this.nexusModId = mod.nexusId;
    this.description = mod.version ?? '';
    this.tooltip = [mod.name, mod.version, mod.nexusId, mod.archiveFilename]
      .filter((s): s is string => !!s)
      .join(' · ');
    this.iconPath = new vscode.ThemeIcon('package');
    this.contextValue = modContextValue(mod, facts);
    this.checkboxState = mod.enabled
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
  }
}

/** Pinned row over the instance's `overwrite/` folder. Not a modlist.txt entry, so it has no
 *  check box and no drag, and no resourceUri, which would let a file decoration tint its label. */
export class OverwriteNode extends vscode.TreeItem {
  readonly kind = OVERWRITE_ORIGIN;
  readonly listed: { readonly files: readonly OriginFile[]; readonly folders: readonly OriginFolder[] };
  readonly shown: ChildrenShown;
  constructor(
    public readonly files: readonly OriginFile[], manager: string, public readonly folders: readonly OriginFolder[] = [],
    found?: { readonly files: readonly OriginFile[]; readonly folders: readonly OriginFolder[] },
  ) {
    const listed = found ?? { files, folders };
    const shown = found ? 'matching' : 'all';
    super(OVERWRITE_LABEL, expanderOver([...listed.files, ...listed.folders], shown));
    this.listed = listed;
    this.shown = shown;
    this.id = this.kind;
    this.contextValue = OVERWRITE_ORIGIN;
    const fileCount = files.length;
    if (fileCount > 0) this.description = fileCount.toLocaleString();
    this.iconPath = fileCount > 0
      ? new vscode.ThemeIcon('folder', new vscode.ThemeColor('charts.red'))
      : new vscode.ThemeIcon('folder');
    this.tooltip = `The files tools wrote while ${manager} ran them, which win over every mod.`;
  }

  lists(): boolean {
    return this.listed.files.length + this.listed.folders.length > 0;
  }
}

export type ModlistNode = SeparatorNode | ModNode | OverwriteNode | FolderNode | FileNode | ErrorNode;

export const NO_MODS_MESSAGE =
  'No mods or separators. Install Mod… or Create Empty Mod…, in the title bar\'s overflow menu, adds one.';

function isEntryNode(node: ModlistNode): node is ModNode | SeparatorNode {
  return node.kind === 'mod' || node.kind === 'separator';
}

/** Sidebar Mods tree over the instance's active profile: rows, statuses and the overwrite count
 *  from the Instance value alone (ADR-0015). */
export class ModListProvider
  implements vscode.TreeDataProvider<ModlistNode>, vscode.TreeDragAndDropController<ModlistNode>, vscode.Disposable
{
  readonly dropMimeTypes = [DND_MIME] as const;
  readonly dragMimeTypes = [DND_MIME] as const;

  private readonly _onDidChangeTreeData = new vscode.EventEmitter<ModlistNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private tree?: ModlistTree;
  private cachedEntries?: ModlistEntry[];
  private modsHoldingPlugin = new Set<string>();
  private filterText = '';
  private filterLower = '';
  private groupingOn = true;
  private direction: SortDirection = 'losingAtTop';
  private readonly instance: InstanceView;
  private instanceValue: InstanceValue;
  private readonly instanceSubscription: vscode.Disposable;
  private readonly readFailureSubscription: vscode.Disposable;
  private readonly firstRead: FirstRead;

  constructor(options: ModListProviderOptions) {
    this.instance = options.instance;
    this.instanceValue = options.instance.value;
    this.firstRead = firstReadOf(options.instance);
    this.instanceSubscription = options.instance.subscribe((value) => {
      this.instanceValue = value;
      this.invalidate();
    });
    this.readFailureSubscription = options.instance.onReadFailure(() => this.render());
  }

  dispose(): void {
    this.instanceSubscription.dispose();
    this.readFailureSubscription.dispose();
    this.firstRead.dispose();
  }

  /** Re-pulls `instance.value` rather than trusting the copy the last subscriber callback left. */
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
  viewMessage(): string | undefined {
    const empty = this.instance.sequence !== 0 && this.instanceValue.mods.length === 0 ? NO_MODS_MESSAGE : undefined;
    return [empty, this.lastGoodReadMessage()].filter((part) => part !== undefined).join(' ') || undefined;
  }

  lastGoodReadMessage(): string | undefined {
    return lastGoodReadMessage(this.instance);
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

  // An entry point to move: it fires the gesture and uses no result (commands.md, Entry points are not gestures).
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
    if (element instanceof SeparatorNode) return element.mods.map((m) => this.modNode(m, element.shown));
    if (element instanceof ModNode) {
      return filesIn(element, modOrigin(element.mod.name), element.files, element.folders, undefined, this.within(element));
    }
    if (element instanceof OverwriteNode) {
      return filesIn(element, RUNTIME_OUTPUT, element.listed.files, element.listed.folders, undefined, this.within(element));
    }
    if (element instanceof FolderNode) {
      return filesIn(element, element.origin, element.files, element.folders, element.folder.relativePath, this.within(element));
    }
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
      this.modsHoldingPlugin = new Set(this.instanceValue.plugins.map((p) => p.origin));
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
      return { ungrouped: this.matchingModNodes(flat), separators: [] };
    }
    return {
      ungrouped: this.filterText ? this.matchingModNodes(ungrouped) : ungrouped.map((m) => this.modNode(m)),
      separators: groups.flatMap((g) => this.groupRow(g) ?? []),
    };
  }

  private groupRow(group: ModlistGroup): SeparatorNode | undefined {
    if (!this.filterText) return this.separatorNode(group.separator, this.inViewOrder(group.mods));
    const shown = shownUnder('matching', this.matches, group.separator.name);
    const mods = shown === 'all' ? group.mods : group.mods.filter(this.isFound);
    return shown === 'all' || mods.length > 0 ? this.separatorNode(group.separator, this.inViewOrder(mods), shown) : undefined;
  }

  private separatorNode(separator: Separator, mods: Mod[], shown?: ChildrenShown): SeparatorNode {
    return new SeparatorNode(separator, mods, shown);
  }

  private overwriteNode(): OverwriteNode {
    const { overwriteFiles, managerNames, overwriteFolders } = this.instanceValue;
    if (!this.filterText) return new OverwriteNode(overwriteFiles, managerNames.manager, overwriteFolders);
    const found = narrowToMatches(overwriteFiles, overwriteFolders, this.matches);
    return new OverwriteNode(overwriteFiles, managerNames.manager, overwriteFolders, found);
  }

  private isFound = (m: Mod): boolean => this.matches(m.name)
    || anyNamed(this.instanceValue.filesByMod.get(m.name) ?? [], this.instanceValue.foldersByMod.get(m.name) ?? [], this.matches);

  private matchingModNodes(mods: readonly Mod[]): ModNode[] {
    return mods.filter(this.isFound).map((m) => this.modNode(m, 'matching'));
  }

  private modNode(m: Mod, parentShown: ChildrenShown = 'all'): ModNode {
    const files = this.instanceValue.filesByMod.get(m.name) ?? [];
    const folders = this.instanceValue.foldersByMod.get(m.name) ?? [];
    const shown = shownUnder(parentShown, this.matches, m.name);
    const found = shown === 'matching' ? narrowToMatches(files, folders, this.matches) : { files, folders };
    return new ModNode(m, {
      holdsPlugin: this.modsHoldingPlugin.has(m.name), tracked: this.instanceValue.trackedMods.has(m.name),
      fileOrderConflict: filesInConflict(this.instanceValue, m.name).length > 0,
    }, found.files, found.folders, shown);
  }

  private within(row: ModNode | OverwriteNode | FolderNode) {
    const conflict = (origin: FileOrigin, file: OriginFile) =>
      fileOrderConflictOf(this.instanceValue.files.get(file.relativePath), origin);
    return { shown: row.shown, matches: this.matches, conflict };
  }

  getParent(element: ModlistNode): ModlistNode | undefined {
    if (element instanceof FolderNode || element instanceof FileNode) return element.parent;
    const group = element instanceof ModNode ? this.groupHolding(element.mod.name) : undefined;
    return group && this.groupRow(group);
  }

  /** The row the tree shows for an origin, or undefined when it shows none. */
  rowFor(origin: FileOrigin): ModNode | OverwriteNode | undefined {
    if (origin.kind !== 'mod') return this.overwriteNode();
    const mod = this.instanceValue.mods.find((entry): entry is Mod => entry.kind === 'mod' && entry.name === origin.name);
    return mod && this.showsMod(mod) ? this.modNode(mod) : undefined;
  }

  private groupHolding(modName: string): ModlistGroup | undefined {
    if (this.filterText && !this.groupingOn) return undefined;
    return this.ensureLoaded().groups.find((g) => g.mods.some((m) => m.name === modName));
  }

  private showsMod(mod: Mod): boolean {
    if (!this.filterText) return true;
    const group = this.groupHolding(mod.name);
    return group ? this.groupRow(group)?.mods.some((m) => m.name === mod.name) === true : this.isFound(mod);
  }

  // modlist.txt is winning-first. View order only.
  private losingFirst(mods: readonly Mod[]): Mod[] {
    return [...mods].reverse();
  }

  private inViewOrder(mods: readonly Mod[]): Mod[] {
    return this.direction === 'winningAtTop' ? [...mods] : this.losingFirst(mods);
  }

  private matches = (name: string): boolean => name.toLowerCase().includes(this.filterLower);

  viewDirection(): SortDirection {
    return this.direction;
  }

  /** Presentation only — never changes which mod wins a conflict. */
  setViewDirection(direction: SortDirection): void {
    this.direction = direction;
    this.invalidate();
  }
}

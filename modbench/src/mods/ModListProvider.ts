import * as vscode from 'vscode';
import type { EntryRef, FileOrigin, Mod, OriginFile, OriginFolder, Separator } from '../instanceLoader/instance';
import { tagsHeldAt } from './tagsHeldAt';
import { modNameOf } from '../instanceLoader/modName';
import { fileOrderConflictOf, modOrigin, OVERWRITE_LABEL, RUNTIME_OUTPUT } from '../instanceLoader/fileConflictIndex';
import { instanceMessages, type InstanceValue, type InstanceView, type ModGroup, type ModGroups } from '../instanceLoader/instance';
import { firstReadOf, type FirstRead } from '../drivingLib/instanceFirstRead';
import { ErrorNode } from '../drivingLib/errorNode';
import { messageLine } from '../drivingLib/messageLine';
import { dropMove, type DraggedRows } from './moveDrop';
import {
  anyNamed, expanderOver, filesIn, narrowToMatches, shownUnder, FileNode, FolderNode,
  type ChildrenShown,
} from './modFiles';
import type { ModArgument } from '../drivingLib/argument';
import { modRowUri, overwriteRowUri, separatorRowUri } from './modIndicators';
import { countsInBadge, differingFiles, lackedLine, separatorDescription, statusDescription, type ModStatuses } from './modStatuses';
import type { ModStatus } from '../client';
import { blankIcon } from '../drivingLib/blankIcon';
import type { SortDirection } from '../drivingLib/sortDirectionToggle';

const DND_MIME = 'application/vnd.medit.modlist-node';

// `DataTransferItem.value` is `any` — handleDrag, below, is this provider's only writer of it.
function isDraggedRows(value: unknown): value is DraggedRows {
  if (typeof value !== 'object' || value === null || !('rows' in value) || !Array.isArray(value.rows)) return false;
  return value.rows.every((row) => row instanceof ModNode || row instanceof SeparatorNode);
}

interface ModListProviderOptions {
  /** Mods/separators in override order, per-mod conflict/override/missing status and the
   *  overwrite/ file count. */
  instance: InstanceView;
  /** Each mod's status against its manifest, which mEdit answers. */
  statuses: Pick<ModStatuses, 'of' | 'onDidChange'>;
}

// Selection and expansion follow a row across a change on disk, and a mod and a separator may
// share a name.
function rowIdentity(kind: 'mod' | 'separator', name: string): string {
  return `${kind}:${name}`;
}

// A space-separated flag string, matching `downloadedFileContextValue`'s own pattern: package.json's
// `when` clauses match a flag with `viewItem =~ /\bflag\b/`.
function modContextValue(mod: Pick<Mod, 'nexusId' | 'enabled'>, facts: ModFacts | undefined): string {
  const flags = [
    mod.nexusId !== undefined && 'hasNexus', mod.enabled ? 'enabled' : 'disabled',
    facts?.holdsPlugin === true && 'holdsPlugin', facts !== undefined && (facts.sourceMod ? 'sourceMod' : 'nonSourceMod'),
    facts?.holdsPublisherTag === true && 'holdsPublisherTag',
  ];
  return ['mod', ...flags.filter((f): f is string => f !== false)].join(' ');
}

interface ModFacts {
  readonly holdsPlugin: boolean;
  readonly sourceMod: boolean;
  readonly holdsPublisherTag?: boolean;
  readonly sourceFolder?: string;
  /** Shown only while the instance holds a repository (modlist-repository.md, Status, story 1). */
  readonly status?: ModStatus;
}

/** A separator and the mods it shows: every mod it holds, or only the matching ones when a filter
 *  shows it for them, and then it opens on its own. */
export class SeparatorNode extends vscode.TreeItem {
  readonly kind = 'separator' as const;
  constructor(
    public readonly separator: Separator,
    public readonly mods: Mod[],
    public readonly shown: ChildrenShown = 'all',
    status?: ModStatus,
  ) {
    super(separator.name, expanderOver(mods, shown));
    this.id = rowIdentity(this.kind, separator.name);
    this.resourceUri = separatorRowUri(separator.name);
    this.iconPath = blankIcon();
    this.contextValue = 'separator';
    this.description = status && separatorDescription(status);
  }
}

const joined = (parts: readonly (string | undefined)[]): string => parts.filter((s): s is string => !!s).join(' · ');

const modTooltip = (mod: Mod, facts: ModFacts | undefined): string => joined([
  mod.name, mod.version, mod.nexusId, mod.installationFileName, facts?.sourceFolder && `built from ${facts.sourceFolder}`,
  facts?.status && lackedLine(facts.status),
]);

export class ModNode extends vscode.TreeItem {
  readonly kind = 'mod' as const;
  readonly argument: ModArgument;
  readonly nexusModId: string | undefined;
  readonly gameName: string | undefined;
  constructor(
    public readonly mod: Mod, public readonly facts?: ModFacts,
    public readonly files: readonly OriginFile[] = [],
    public readonly folders: readonly OriginFolder[] = [],
    public readonly shown: ChildrenShown = 'all',
  ) {
    super(mod.name, expanderOver([...files, ...folders], shown));
    this.argument = { kind: 'mod', name: mod.name };
    this.id = rowIdentity(this.kind, mod.name);
    this.resourceUri = modRowUri(mod.name);
    this.nexusModId = mod.nexusId;
    this.gameName = mod.gameName;
    this.description = joined([mod.version, facts?.status && statusDescription(facts.status)]);
    this.tooltip = modTooltip(mod, facts);
    this.iconPath = new vscode.ThemeIcon(facts?.sourceMod ? 'repo' : 'package');
    this.contextValue = modContextValue(mod, facts);
    this.checkboxState = mod.enabled
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
  }
}

/** Pinned row over the instance's `overwrite/` folder. Not an entry of mod order, so it has no
 *  check box and no drag. */
export class OverwriteNode extends vscode.TreeItem {
  readonly kind = 'runtimeOutput';
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
    this.contextValue = this.kind;
    this.resourceUri = overwriteRowUri();
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

const NO_MODS_MESSAGE =
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

  private modGroups?: ModGroups;
  private modsHoldingPlugin = new Set<string>();
  private filterText = '';
  private filterLower = '';
  private groupingOn = true;
  private direction: SortDirection = 'losingAtTop';
  private readonly instance: InstanceView;
  private instanceValue: InstanceValue;
  private readonly instanceSubscription: vscode.Disposable;
  private readonly readFailureSubscription: vscode.Disposable;
  private readonly statusSubscription: vscode.Disposable;
  private readonly statuses: ModListProviderOptions['statuses'];
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
    this.statuses = options.statuses;
    this.statusSubscription = options.statuses.onDidChange(() => this.render());
  }

  dispose(): void {
    this.instanceSubscription.dispose();
    this.readFailureSubscription.dispose();
    this.statusSubscription.dispose();
    this.firstRead.dispose();
  }

  /** Re-pulls `instance.value` rather than trusting the copy the last subscriber callback left. */
  invalidate(): void {
    this.instanceValue = this.instance.value;
    this.modGroups = undefined;
    this._onDidChangeTreeData.fire(undefined);
  }

  private render(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  /** Render-only: a filter keystroke narrows already-built rows and never re-reads the value. */
  setFilter(text: string, grouping: boolean): void {
    this.filterText = text;
    this.filterLower = text.toLowerCase();
    this.groupingOn = grouping;
    this.render();
  }

  /** The enabled mods over the listed mods, whatever the filter shows. */
  description(): string | undefined {
    if (this.instance.sequence === 0) return undefined;
    const mods = this.instanceValue.mods.filter((entry) => entry.kind === 'mod');
    return `${mods.filter((mod) => mod.enabled).length} / ${mods.length}`;
  }

  /** A row the view still holds may predate the value, so its mod's state is read from the value. */
  isEnabled(row: ModNode): boolean {
    const entry = this.instanceValue.mods.find((m) => m.kind === 'mod' && m.name === row.mod.name);
    return entry?.enabled ?? row.mod.enabled;
  }

  /** The modlist's badge: how many mods differ from their manifests or have none (modlist-repository.md, Status, story 5). */
  badge(): { value: number; tooltip: string } | undefined {
    const count = this.instanceValue.mods.filter((entry) => {
      const status = this.statusOf(entry);
      return status !== undefined && countsInBadge(status);
    }).length;
    return count === 0 ? undefined : { value: count, tooltip: `Mods that differ from their manifests or have none: ${count}` };
  }

  private statusOf(entry: EntryRef): ModStatus | undefined {
    const name = modNameOf(this.instanceValue.modNames, entry);
    return this.instanceValue.holdsRepository && name !== undefined ? this.statuses.of(name) : undefined;
  }

  /** The view's message line while no filter is active. Overwrite is always a row, so an empty
   *  list says so here, above it. */
  viewMessage(): string | undefined {
    const empty = this.instance.sequence !== 0 && this.instanceValue.mods.length === 0 ? NO_MODS_MESSAGE : undefined;
    return messageLine(empty, this.standingMessage());
  }

  standingMessage(): string | undefined {
    return messageLine(...instanceMessages(this.instance));
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

    const { ungrouped, separators } = this.entryRoots(this.loadedModGroups());
    const overwrite = this.overwriteNode();
    return this.direction === 'winningAtTop'
      ? [overwrite, ...[...separators].reverse(), ...[...ungrouped].reverse()]
      : [...ungrouped, ...separators, overwrite];
  }

  private loadedModGroups(): ModGroups {
    if (!this.modGroups) {
      this.modGroups = this.instanceValue.modGroups;
      this.modsHoldingPlugin = new Set(this.instanceValue.plugins.map((p) => p.origin));
    }
    return this.modGroups;
  }

  // The roots other than Overwrite, losing end first: the ungrouped mods, which sit below every
  // separator in mod order, and then the separators. The flat list is all ungrouped.
  private entryRoots(tree: ModGroups): { ungrouped: ModlistNode[]; separators: ModlistNode[] } {
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

  private groupRow(group: ModGroup): SeparatorNode | undefined {
    if (!this.filterText) return this.separatorNode(group.separator, this.inViewOrder(group.mods));
    const shown = shownUnder('matching', this.matches, group.separator.name);
    const mods = shown === 'all' ? group.mods : group.mods.filter(this.isFound);
    return shown === 'all' || mods.length > 0 ? this.separatorNode(group.separator, this.inViewOrder(mods), shown) : undefined;
  }

  private separatorNode(separator: Separator, mods: Mod[], shown?: ChildrenShown): SeparatorNode {
    return new SeparatorNode(separator, mods, shown, this.statusOf(separator));
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
    const sourceMod = this.instanceValue.listedSourceMods.has(m.name);
    return new ModNode(m, {
      holdsPlugin: this.modsHoldingPlugin.has(m.name), sourceMod,
      sourceFolder: sourceMod ? this.instanceValue.paths.sourceDirs.get(m.name) : undefined,
      status: this.statusOf(m), holdsPublisherTag: tagsHeldAt(this.instanceValue, this.instanceValue.paths.modDirs.get(m.name)).length > 0,
    }, found.files, found.folders, shown);
  }

  private within(row: ModNode | OverwriteNode | FolderNode) {
    const conflict = (origin: FileOrigin, file: OriginFile) =>
      fileOrderConflictOf(this.instanceValue.files.get(file.relativePath), origin);
    const differs = (origin: FileOrigin, relativePath: string) => {
      const status = origin.kind === 'mod' ? this.statusOf(origin) : undefined;
      return status !== undefined && [...differingFiles(status)].some((path) => path === relativePath || path.startsWith(`${relativePath}/`));
    };
    const holdsPublisherTag = (path: string) => tagsHeldAt(this.instanceValue, path).length > 0;
    return { shown: row.shown, matches: this.matches, conflict, differs, holdsPublisherTag };
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

  private groupHolding(modName: string): ModGroup | undefined {
    if (this.filterText && !this.groupingOn) return undefined;
    return this.loadedModGroups().groups.find((g) => g.mods.some((m) => m.name === modName));
  }

  private showsMod(mod: Mod): boolean {
    if (!this.filterText) return true;
    const group = this.groupHolding(mod.name);
    return group ? this.groupRow(group)?.mods.some((m) => m.name === mod.name) === true : this.isFound(mod);
  }

  // Mod order is winning-first. View order only.
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

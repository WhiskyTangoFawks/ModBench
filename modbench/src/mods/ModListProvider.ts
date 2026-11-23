import * as vscode from 'vscode';
import { RedrawEmitter } from '../drivingLib/heldRedraw';
import { MODS_KEY_ARGS } from './gestureEntry';
import { gameReleaseForGame } from '../tables/gamePaths';
import type { EntryRef, FileOrigin, Mod, OriginFile, OriginFolder, Separator } from '../instanceLoader/instance';
import { tagsHeldAt } from './tagsHeldAt';
import { modNameOf } from '../instanceLoader/modName';
import { fileOrderConflictOf, modOrigin, OVERWRITE_LABEL, RUNTIME_OUTPUT } from '../instanceLoader/fileConflictIndex';
import { modEntryOf, originsTouched } from './originsTouched';
import { instanceMessages, MESSAGE_READS, type InstanceOf, type ModGroup, type ModGroups, type Told } from '../instanceLoader/instance';
import { gameFolderFileOver, unreadableArchiveReason } from './modFileStates';
import { firstReadOf, type FirstRead } from '../drivingLib/instanceFirstRead';
import { ErrorNode } from '../drivingLib/errorNode';
import { messageLine } from '../drivingLib/messageLine';
import { dropMove, type DraggedRows } from './moveDrop';
import {
  anyNamed, archivedIn, expanderOver, filesIn, narrowToMatches, shownUnder, ArchivedFileNode, ArchivedFolderNode, FileNode, FolderNode,
  type ArchivedEntry, type ChildrenShown, type FileIgnore,
} from './modFiles';
import type { ModArgument } from '../drivingLib/argument';
import { modRowUri, overwriteRowUri, separatorRowUri } from './modIndicators';
import type { OpenRows } from './openRows';
import { groupSeparators, type SeparatorEntry, type SeparatorGroup, type SeparatorLeaf } from './separatorGroups';
import { countsInBadge, differingFiles, ignoreEntriesOf, ignoredFiles, lackedLine, statusDescription } from './statusText';
import type { ModStatuses } from '../modStatus/modStatuses';
import type { ModStatus } from '../manifestAdapter/manifestAdapter';
import { blankIcon } from '../drivingLib/blankIcon';
import type { SortDirection } from '../drivingLib/sortDirectionToggle';
import type { Reporter } from '../ports/reporter';

const DND_MIME = 'application/vnd.medit.modlist-node';

// `DataTransferItem.value` is `any` — handleDrag, below, is this provider's only writer of it.
function isDraggedRows(value: unknown): value is DraggedRows {
  if (typeof value !== 'object' || value === null || !('rows' in value) || !Array.isArray(value.rows)) return false;
  if (!value.rows.every((row) => row instanceof ModNode || row instanceof SeparatorNode)) return false;
  return 'focused' in value && value.rows.some((row) => row === value.focused);
}

const TREE_READS = {
  ...MESSAGE_READS, mods: true, modGroups: true, modNames: true, holdsRepository: true, gameName: true, dataFolderFiles: true, stackedCopies: true, plugins: true,
  overwriteFiles: true, overwriteFolders: true, filesByMod: true, foldersByMod: true, listedSourceMods: true, paths: true, publisherConfiguration: true,
  files: true, archiveContents: true, loadsArchive: true,
} as const;

type TreeInstance = InstanceOf<keyof typeof TREE_READS>;

interface ModListProviderOptions {
  /** Mods/separators in override order, per-mod conflict/override/missing status and the
   *  overwrite/ file count. */
  instance: TreeInstance;
  /** Each mod's status against its manifest, as Mod status derives it. */
  statuses: Pick<ModStatuses, 'of' | 'lastGoodReasons' | 'onDidChange'>;
  /** The rows the view shows open. */
  open: OpenRows;
  /** Says why a drop cannot land. */
  reporter: Reporter;
}

// Selection and expansion follow a row across a change on disk, and a mod and a separator may
// share a name.
function rowIdentity(kind: 'mod' | 'separator' | 'separatorGroup', name: string): string {
  return `${kind}:${name}`;
}

// A space-separated flag string, matching `downloadedFileContextValue`'s own pattern: package.json's
// `when` clauses match a flag with `viewItem =~ /\bflag\b/`.
function modContextValue(mod: Pick<Mod, 'nexusId' | 'enabled'>, facts: ModFacts | undefined): string {
  const flags = [
    mod.nexusId !== undefined && 'hasNexus', mod.enabled ? 'enabled' : 'disabled',
    facts?.holdsPlugin === true && 'holdsPlugin', facts !== undefined && (facts.sourceMod ? 'sourceMod' : 'nonSourceMod'),
    facts?.holdsPublisherTag === true && 'holdsPublisherTag',
    facts?.status?.heldWhole === true && 'heldWhole',
  ];
  return ['mod', ...flags.filter((f): f is string => f !== false)].join(' ');
}

interface ModFacts {
  readonly holdsPlugin: boolean;
  readonly sourceMod: boolean;
  readonly holdsPublisherTag?: boolean;
  readonly sourceFolder?: string;
  /** Shown only while the instance holds a repository (instance-repository.md, Status, story 1). */
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
    public readonly text: string = separator.name,
  ) {
    super(text, expanderOver(mods, shown));
    this.id = rowIdentity(this.kind, separator.name);
    this.resourceUri = separatorRowUri(separator.name);
    this.iconPath = blankIcon();
    this.contextValue = 'separator';
  }
}

/** A heading over the consecutive separators that share its prefix. It is no mod entry: no gesture reaches it. */
export class SeparatorGroupNode extends vscode.TreeItem {
  readonly kind = 'separatorGroup' as const;
  constructor(public readonly group: SeparatorGroup, public readonly rows: readonly (SeparatorNode | SeparatorGroupNode)[], public readonly shown: ChildrenShown = 'all') {
    super(group.label, expanderOver(rows, shown));
    this.id = rowIdentity(this.kind, JSON.stringify([group.path, group.run]));
    this.contextValue = this.kind;
    this.iconPath = blankIcon();
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

export type ModlistNode = SeparatorNode | SeparatorGroupNode | ModNode | OverwriteNode | FolderNode | FileNode | ArchivedFolderNode | ArchivedFileNode | ErrorNode;

const NO_MODS_MESSAGE =
  'No mods or separators. Install Mod… or Create Empty Mod…, in the title bar\'s overflow menu, adds one.';

// The Instance loader hands an archive's read on unchanged until its stamp changes, so the filter builds its entries once.
const entriesOfRead = new WeakMap<object, readonly ArchivedEntry[]>();

function isEntryNode(node: ModlistNode): node is ModNode | SeparatorNode {
  return node.kind === 'mod' || node.kind === 'separator';
}

/** Sidebar Mods tree over the instance's active profile: rows, statuses and the overwrite count
 *  from the Instance value alone. */
export class ModListProvider
  implements vscode.TreeDataProvider<ModlistNode>, vscode.TreeDragAndDropController<ModlistNode>, vscode.Disposable
{
  readonly dropMimeTypes = [DND_MIME] as const;
  readonly dragMimeTypes = [DND_MIME] as const;

  private readonly _onDidChangeTreeData = new RedrawEmitter<ModlistNode | undefined>(MODS_KEY_ARGS.view);
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private modGroups?: ModGroups;
  private separatorEntries?: { readonly roots: readonly SeparatorEntry[]; readonly leaves: ReadonlyMap<string, SeparatorLeaf> };
  private modsHoldingPlugin = new Set<string>();
  private filterText = '';
  private filterLower = '';
  private groupingOn = true;
  private direction: SortDirection = 'losingAtTop';
  private highlighted: readonly FileOrigin[] = [];
  private positionsHeld: ReadonlyMap<string, string> | undefined;
  private marks: ReadonlySet<string> | undefined;
  private readonly instance: TreeInstance;
  private instanceValue: TreeInstance['value'];
  private readonly instanceSubscription: vscode.Disposable;
  private readonly readFailureSubscription: vscode.Disposable;
  private readonly statusSubscription: vscode.Disposable;
  private readonly openSubscription: vscode.Disposable;
  private readonly statuses: ModListProviderOptions['statuses'];
  private readonly open: OpenRows;
  private readonly reporter: Reporter;
  private readonly firstRead: FirstRead;

  constructor(options: ModListProviderOptions) {
    this.instance = options.instance;
    this.instanceValue = options.instance.value;
    this.firstRead = firstReadOf(options.instance);
    this.instanceSubscription = options.instance.subscribe((_value, _sequence, told) => { this.update(told); }, TREE_READS);
    this.readFailureSubscription = options.instance.onReadFailure(() => this.render());
    this.statuses = options.statuses;
    this.open = options.open;
    this.reporter = options.reporter;
    // The badge counts a mod the filter hides too, so a status with no row to fire draws the tree again.
    this.statusSubscription = options.statuses.onDidChange((mods) => {
      if (mods === 'every' || ![...mods].every((name) => this.fireRow(rowIdentity('mod', name)))) this.render();
    });
    this.openSubscription = options.open.onDidChange(() => {
      const before = this.marks;
      if (before) this.fireChangedMarks(before);
    });
  }

  dispose(): void {
    this.instanceSubscription.dispose();
    this.readFailureSubscription.dispose();
    this.statusSubscription.dispose();
    this.openSubscription.dispose();
    this.firstRead.dispose();
  }

  // A filter shows a row by its files, so under one any change may show or hide a row.
  private update(told: Told<keyof typeof TREE_READS>): void {
    const touched = this.filterText === '' ? originsTouched(this.instance.value, told) : 'every';
    if (touched === 'every') {
      this.invalidate();
      return;
    }
    this.instanceValue = this.instance.value;
    for (const origin of touched) this.fireRow(origin.kind === 'mod' ? rowIdentity('mod', origin.name) : RUNTIME_OUTPUT.kind);
  }

  /** Re-pulls `instance.value` rather than trusting the copy the last subscriber callback left. */
  invalidate(): void {
    this.instanceValue = this.instance.value;
    this.modGroups = undefined;
    this.separatorEntries = undefined;
    this.positionsHeld = undefined;
    this.marks = undefined;
    this._onDidChangeTreeData.fire(undefined);
  }

  // Mod order arrives winning-first; a position counts from the losing end, a separator included.
  private positions(): ReadonlyMap<string, string> {
    if (!this.positionsHeld) {
      const { mods } = this.instanceValue;
      const width = String(Math.max(0, mods.length - 1)).length;
      this.positionsHeld = new Map(mods.flatMap((entry, at) =>
        entry.kind === 'mod' ? [[entry.name, String(mods.length - 1 - at).padStart(width, '0')] as const] : []));
    }
    return this.positionsHeld;
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

  /** The modlist's badge: how many mods differ from their manifests or have none (instance-repository.md, Status, story 4). */
  badge(): { value: number; tooltip: string } | undefined {
    const count = this.instanceValue.mods.filter((entry) => {
      const status = entry.kind === 'mod' ? this.statusOf(entry) : undefined;
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
    return messageLine(...instanceMessages(this.instance, this.instanceValue.holdsRepository ? this.statuses.lastGoodReasons() : []));
  }

  // No stable API names the focused row. VS Code appends the row a click selects to the selection
  // it drags, so the last row stands in for it.
  handleDrag(
    source: readonly ModlistNode[],
    dataTransfer: vscode.DataTransfer,
    _token: vscode.CancellationToken,
  ): void {
    const rows = source.filter(isEntryNode);
    const focused = rows.at(-1);
    if (focused === undefined) return;
    const dragged: DraggedRows = { rows, focused };
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
    if ('refusal' in move) {
      this.reporter.report('error', `Could not move ${payload.value.focused.kind}s.`, move.refusal);
      return;
    }
    await vscode.commands.executeCommand('modbench.mod.move', move.argument[0], move.argument, move.target);
  }


  getTreeItem(element: ModlistNode): vscode.TreeItem {
    if (element instanceof ModNode || element instanceof SeparatorNode || element instanceof OverwriteNode) {
      const label = element instanceof ModNode ? `${this.positions().get(element.mod.name) ?? ''} ${element.mod.name}`.trimStart() : element instanceof SeparatorNode ? element.text : OVERWRITE_LABEL;
      element.label = this.marked().has(element.id ?? '') ? { label, highlights: [[0, label.length]] } : label;
    }
    return element;
  }

  /** Marks the labels of the rows for these origins, and of each collapsed separator that holds one (mods.md, The tree, story 11). */
  highlight(origins: readonly FileOrigin[]): void {
    const before = this.marked();
    this.highlighted = origins;
    this.fireChangedMarks(before);
  }

  private fireChangedMarks(before: ReadonlySet<string>): void {
    this.marks = undefined;
    const after = this.marked();
    for (const id of new Set([...before, ...after])) {
      if (before.has(id) !== after.has(id)) this.fireRow(id);
    }
  }

  // Whether the tree shows the row, which it then asks again for.
  private fireRow(id: string): boolean {
    const row = id === 'runtimeOutput' ? this.overwriteNode()
      : id.startsWith('mod:') ? this.rowFor(modOrigin(id.slice('mod:'.length)))
        : this.separatorRowNamed(id.slice('separator:'.length));
    if (row) this._onDidChangeTreeData.fire(row);
    return row !== undefined;
  }

  private marked(): ReadonlySet<string> {
    this.marks ??= this.markedRows();
    return this.marks;
  }

  private markedRows(): ReadonlySet<string> {
    const mods = new Set(this.highlighted.flatMap((origin) => (origin.kind === 'mod' ? [origin.name] : [])));
    const ids = new Set([...mods].map((name) => rowIdentity('mod', name)));
    if (this.highlighted.some((origin) => origin.kind === 'runtimeOutput')) ids.add('runtimeOutput');
    for (const { separator, mods: held } of this.loadedModGroups().groups) {
      if (!this.open.has(separatorRowUri(separator.name).toString()) && held.some((m) => mods.has(m.name))) ids.add(rowIdentity('separator', separator.name));
    }
    return ids;
  }

  async getChildren(element?: ModlistNode): Promise<ModlistNode[]> {
    if (element instanceof SeparatorGroupNode) return [...element.rows];
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
    if (element instanceof FileNode || element instanceof ArchivedFolderNode) return archivedIn(element, this.matches, gameReleaseForGame(this.instanceValue.gameName), (entry) => gameFolderFileOver(this.instanceValue, entry));
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
    if (this.flat()) {
      const flat = [...ungrouped, ...this.losingFirst(tree.groups).flatMap((g) => this.losingFirst(g.mods))];
      return { ungrouped: this.matchingModNodes(flat), separators: [] };
    }
    return {
      ungrouped: this.filterText ? this.matchingModNodes(ungrouped) : ungrouped.map((m) => this.modNode(m)),
      separators: this.losingFirst(this.entries().roots).flatMap((entry) => this.rowOf(entry) ?? []),
    };
  }

  private rowOf(entry: SeparatorEntry, parentShown: ChildrenShown = this.filterText ? 'matching' : 'all'): SeparatorNode | SeparatorGroupNode | undefined {
    if (entry.kind === 'separator') return this.leafRow(entry, parentShown);
    const shown = shownUnder(parentShown, this.matches, entry.label);
    const rows = this.inViewOrder(entry.children).flatMap((child) => this.rowOf(child, shown) ?? []);
    return shown === 'all' || rows.length > 0 ? new SeparatorGroupNode(entry, rows, shown) : undefined;
  }

  private separatorRowNamed(name: string): SeparatorNode | undefined {
    const leaf = this.leafNamed(name);
    return leaf && this.leafRow(leaf, this.filterText ? 'matching' : 'all');
  }

  private leafRow({ held, label }: SeparatorLeaf, parentShown: ChildrenShown): SeparatorNode | undefined {
    const shown = shownUnder(parentShown, this.matches, held.separator.name);
    const mods = shown === 'all' ? held.mods : held.mods.filter(this.isFound);
    return shown === 'all' || mods.length > 0 ? new SeparatorNode(held.separator, this.inViewOrder(mods), shown, label) : undefined;
  }

  private overwriteNode(): OverwriteNode {
    const { overwriteFiles, managerNames, overwriteFolders } = this.instanceValue;
    if (!this.filterText) return new OverwriteNode(overwriteFiles, managerNames.manager, overwriteFolders);
    const found = narrowToMatches(overwriteFiles, overwriteFolders, this.matches, this.archivedOf);
    return new OverwriteNode(overwriteFiles, managerNames.manager, overwriteFolders, found);
  }

  private isFound = (m: Mod): boolean => this.matches(m.name)
    || anyNamed(this.instanceValue.filesByMod.get(m.name) ?? [], this.instanceValue.foldersByMod.get(m.name) ?? [], this.matches, this.archivedOf);

  private matchingModNodes(mods: readonly Mod[]): ModNode[] {
    return mods.filter(this.isFound).map((m) => this.modNode(m, 'matching'));
  }

  private modNode(m: Mod, parentShown: ChildrenShown = 'all'): ModNode {
    const files = this.instanceValue.filesByMod.get(m.name) ?? [];
    const folders = this.instanceValue.foldersByMod.get(m.name) ?? [];
    const shown = shownUnder(parentShown, this.matches, m.name);
    const found = shown === 'matching' ? narrowToMatches(files, folders, this.matches, this.archivedOf) : { files, folders };
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
    const ignored = (origin: FileOrigin, file: OriginFile): FileIgnore => {
      const status = origin.kind === 'mod' ? this.statusOf(origin) : undefined;
      if (status === undefined || !ignoredFiles(status).has(file.relativePath)) return 'unignored';
      return ignoreEntriesOf(status).has(file.includedPath) ? 'entry' : 'under';
    };
    const holdsPublisherTag = (path: string) => tagsHeldAt(this.instanceValue, path).length > 0;
    return { shown: row.shown, matches: this.matches, conflict, differs, ignored, holdsPublisherTag, archived: this.archivedOf, unreadable: (file: OriginFile) => unreadableArchiveReason(this.instanceValue, file) };
  }

  private archivedOf = (file: OriginFile): readonly ArchivedEntry[] => {
    const read = this.instanceValue.archiveContents.get(file.sourcePath);
    if (read?.kind !== 'read') return [];
    const entries = entriesOfRead.get(read) ?? read.answer.map((relativePath) => ({ relativePath }));
    entriesOfRead.set(read, entries);
    return entries;
  };

  getParent(element: ModlistNode): ModlistNode | undefined {
    if (element instanceof FolderNode || element instanceof FileNode || element instanceof ArchivedFolderNode || element instanceof ArchivedFileNode) return element.parent;
    if (element instanceof SeparatorNode || element instanceof SeparatorGroupNode) {
      const parent = element instanceof SeparatorNode ? this.leafNamed(element.separator.name)?.parent : element.group.parent;
      return this.flat() ? undefined : parent && this.rowOf(parent);
    }
    const group = element instanceof ModNode ? this.groupHolding(element.mod.name) : undefined;
    return group && this.separatorRowNamed(group.separator.name);
  }

  private flat(): boolean {
    return this.filterText !== '' && !this.groupingOn;
  }

  private entries() {
    this.separatorEntries ??= (() => {
      const roots = groupSeparators(this.loadedModGroups().groups);
      const leaves = new Map<string, SeparatorLeaf>();
      const visit = (entry: SeparatorEntry): void => {
        if (entry.kind === 'group') entry.children.forEach(visit);
        else leaves.set(entry.held.separator.name, entry);
      };
      roots.forEach(visit);
      return { roots, leaves };
    })();
    return this.separatorEntries;
  }

  private leafNamed(name: string): SeparatorLeaf | undefined {
    return this.entries().leaves.get(name);
  }

  /** Draws the rows of `mods` at once, held or not, so a check box the user clicked shows the value (common.md, A gesture
   *  that writes, story 2). */
  restoreRows(mods: readonly string[]): void {
    this._onDidChangeTreeData.restore(mods.flatMap((name) => this.rowFor(modOrigin(name)) ?? []));
  }

  /** The row the tree shows for an origin, or undefined when it shows none. */
  rowFor(origin: FileOrigin): ModNode | OverwriteNode | undefined {
    if (origin.kind !== 'mod') return this.overwriteNode();
    const mod = modEntryOf(this.instanceValue.mods, origin.name);
    return mod && this.showsMod(mod) ? this.modNode(mod) : undefined;
  }

  /** The row the tree shows for a mod or a separator, or undefined when it shows none. */
  entryRow({ kind, name }: EntryRef): ModNode | SeparatorNode | undefined {
    if (kind === 'separator') return this.separatorRowNamed(name);
    const row = this.rowFor(modOrigin(name));
    return row?.kind === 'mod' ? row : undefined;
  }

  private groupHolding(modName: string): ModGroup | undefined {
    if (this.flat()) return undefined;
    return this.loadedModGroups().groups.find((g) => g.mods.some((m) => m.name === modName));
  }

  private showsMod(mod: Mod): boolean {
    if (!this.filterText) return true;
    const group = this.groupHolding(mod.name);
    return group ? this.separatorRowNamed(group.separator.name)?.mods.some((m) => m.name === mod.name) === true : this.isFound(mod);
  }

  // Mod order is winning-first. View order only.
  private losingFirst<T>(rows: readonly T[]): T[] {
    return [...rows].reverse();
  }

  private inViewOrder<T>(rows: readonly T[]): T[] {
    return this.direction === 'winningAtTop' ? [...rows] : [...rows].reverse();
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

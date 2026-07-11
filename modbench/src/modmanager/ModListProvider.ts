import * as vscode from 'vscode';
import type { IModlistSource, Mod, ModlistEntry, Separator } from './model';
import { groupModlist, type ModlistTree } from './modlistTree';
import { buildFileConflictIndex } from './fileConflictIndex';
import { computeModStatuses, type ModStatus, type ModStatusResult } from './statusChecker';
import { readVanillaMasters } from './vanillaMasters';
// Pure drop-index reconciliation, shared with PluginListProvider. A neutral
// home would be warranted if a third consumer appears; not worth the churn yet.
import { dropIndexForMove } from './mo2/pluginsText';
import type { Reporter } from './deployer';

const DND_MIME = 'application/vnd.medit.modlist-node';

/** Shared resolved-undefined default for an omitted `dataFolder` — hoisted out of
 *  the constructor so it isn't a fresh async operation per instance. */
const NO_DATA_FOLDER: Promise<string | undefined> = Promise.resolve(undefined);

/** Constructor options for {@link ModListProvider}. Field order matches
 *  PluginListProvider's identically-shaped options so the two siblings read the
 *  same (issue #80: replaces five positional args whose order diverged). */
export interface ModListProviderOptions {
  source: IModlistSource;
  log?: (msg: string) => void;
  reporter?: Reporter;
  instanceRoot?: string;
  dataFolder?: Promise<string | undefined>;
}

/** 'ok'/undefined -&gt; default package icon; warn for conflicts, error for broken. */
function statusIconId(status?: ModStatusResult): string {
  switch (status?.status.kind) {
    case 'conflicts':
    case 'overrides':
      return 'warning';
    case 'missingMaster':
    case 'missingMod':
      return 'error';
    default:
      return 'package';
  }
}

function statusLabel(status: ModStatus): string {
  switch (status.kind) {
    case 'conflicts': return `⚠ ${status.count} conflicts`;
    case 'overrides': return `⚠ Overrides ${status.count}`;
    case 'missingMaster': return `✗ Missing master: ${status.masters.join(', ')}`;
    case 'missingMod': return '✗ Missing mod';
    case 'ok': return '';
  }
}

/** Non-interactive first root item: "247 active / 312 installed". */
export class CountNode extends vscode.TreeItem {
  readonly kind = 'count' as const;
  constructor(activeCount: number, installedCount: number) {
    super(`${activeCount} active / ${installedCount} installed`, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'modCount';
  }
}

/** Collapsible separator; children are the mods that follow it in modlist.txt. */
export class SeparatorNode extends vscode.TreeItem {
  readonly kind = 'separator' as const;
  constructor(public readonly separator: Separator, public readonly mods: Mod[]) {
    super(separator.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'separator';
  }
}

/** Inline error surface: shown instead of an empty list when a fetch/read fails,
 *  so a failure is never indistinguishable from "nothing here" (ADR-0026). */
export class ErrorNode extends vscode.TreeItem {
  readonly kind = 'error' as const;
  constructor(message: string) {
    super(`⚠ Failed to load: ${message}`, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'error';
    this.tooltip = message;
    this.iconPath = new vscode.ThemeIcon('error');
  }
}

/** A mod row with a native checkbox, version description, and tooltip.
 *  `status` (Modbench-3) overlays a conflict/missing-master/missing-mod badge
 *  onto the icon, description, and tooltip when present and not 'ok'. */
export class ModNode extends vscode.TreeItem {
  readonly kind = 'mod' as const;
  constructor(public readonly mod: Mod, status?: ModStatusResult) {
    super(mod.name, vscode.TreeItemCollapsibleState.None);
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
    this.contextValue = mod.nexusId ? 'modWithNexus' : 'mod';
    this.checkboxState = mod.enabled
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
  }
}

export type ModlistNode = CountNode | SeparatorNode | ModNode | ErrorNode;

/** Mod/separator rows are the only nodes with a modlist.txt entry to drag or index;
 *  CountNode and ErrorNode are non-interactive summary/status rows. */
function isEntryNode(node: ModlistNode): node is ModNode | SeparatorNode {
  return node.kind === 'mod' || node.kind === 'separator';
}

/** Sidebar Mod List (Loadout) tree over an MO2 instance's active profile. */
export class ModListProvider
  implements vscode.TreeDataProvider<ModlistNode>, vscode.TreeDragAndDropController<ModlistNode>
{
  readonly dropMimeTypes = [DND_MIME] as const;
  readonly dragMimeTypes = [DND_MIME] as const;

  private readonly _onDidChangeTreeData = new vscode.EventEmitter<ModlistNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private tree?: ModlistTree;
  private cachedEntries?: ModlistEntry[];
  private statuses?: Map<string, ModStatusResult>;
  private loadError?: string;
  private filterText = '';
  private filterLower = '';
  private groupingOn = true;
  private sortDescending = false;
  private readonly source: IModlistSource;
  private readonly log: (msg: string) => void;
  private readonly reporter?: Reporter;
  private readonly instanceRoot?: string;
  private readonly dataFolder: Promise<string | undefined>;

  /** `instanceRoot`, when provided, enables status badges (Modbench-3):
   *  file-conflict index + missing-master/missing-mod checks against real
   *  files on disk. Omitted in tests that use an in-memory-only source.
   *  `reporter`, when provided, surfaces a status-computation failure as a
   *  warning (ADR-0026: badges silently absent would otherwise look
   *  identical to "no conflicts"). `dataFolder` is the game's resolved Data
   *  folder (the single GameDirectory resolved once at the composition root,
   *  #78) — its vanilla/DLC masters seed the missing-master check; a resolved
   *  `Promise<undefined>` degrades that check to an empty set. */
  constructor(options: ModListProviderOptions) {
    this.source = options.source;
    this.log = options.log ?? (() => {});
    this.reporter = options.reporter;
    this.instanceRoot = options.instanceRoot;
    this.dataFolder = options.dataFolder ?? NO_DATA_FOLDER;
  }

  refresh(): void {
    this.tree = undefined;
    this.cachedEntries = undefined;
    this.statuses = undefined;
    this.loadError = undefined;
    this._onDidChangeTreeData.fire(undefined);
  }

  /** Update the filter and refresh the tree. Clears always resets groupingOn to true. */
  setFilter(text: string, grouping: boolean): void {
    this.filterText = text;
    this.filterLower = text.toLowerCase();
    this.groupingOn = text === '' ? true : grouping;
    this.refresh();
  }

  handleDrag(
    source: readonly ModlistNode[],
    dataTransfer: vscode.DataTransfer,
    _token: vscode.CancellationToken,
  ): void {
    const node = source[0];
    if (!node || !isEntryNode(node)) return;
    const name = node.kind === 'mod' ? node.mod.name : node.separator.name;
    dataTransfer.set(DND_MIME, new vscode.DataTransferItem({ kind: node.kind, name }));
  }

  async handleDrop(
    target: ModlistNode | undefined,
    dataTransfer: vscode.DataTransfer,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    const payload = dataTransfer.get(DND_MIME);
    if (!payload) return;
    if (target?.kind === 'count') return;
    const { kind, name } = payload.value as { kind: 'mod' | 'separator'; name: string };
    // A drop hands us the *pre-removal* target ("insert before this row"), but
    // moveModInText/moveSeparatorBlockInText count toIndex among the entries with
    // the moved line(s) already removed — so any moved entry above the target
    // shifts it left. dropIndexForMove reconciles that; a separator drops its
    // whole block, so all block members count as "moved" (#76).
    const order = this.cachedEntries?.map((e) => e.name) ?? [];
    const targetName = this.targetName(target);
    if (kind === 'mod') {
      if (target instanceof SeparatorNode) {
        await this.source.moveModToSeparator(name, target.separator.name);
      } else {
        await this.source.reorder(name, dropIndexForMove(order, [name], targetName));
      }
    } else {
      await this.source.reorderSeparatorBlock(name, dropIndexForMove(order, this.separatorBlockNames(name), targetName));
    }
    this.refresh();
  }

  /** The dropped-onto row's entry name, or undefined to drop past the last row. */
  private targetName(node: ModlistNode | undefined): string | undefined {
    if (!node || !isEntryNode(node)) return undefined;
    return node.kind === 'mod' ? node.mod.name : node.separator.name;
  }

  /** A separator moves with its children as a block: the separator plus every
   *  following entry up to (not including) the next separator — matching
   *  moveSeparatorBlockInText's block extent. */
  private separatorBlockNames(sepName: string): string[] {
    const entries = this.cachedEntries ?? [];
    const start = entries.findIndex((e) => e.kind === 'separator' && e.name === sepName);
    if (start < 0) return [sepName];
    const names = [sepName];
    for (let i = start + 1; i < entries.length && entries[i].kind !== 'separator'; i++) {
      names.push(entries[i].name);
    }
    return names;
  }

  getTreeItem(element: ModlistNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: ModlistNode): Promise<ModlistNode[]> {
    if (element instanceof SeparatorNode) return this.separatorChildren(element);
    if (element) return [];

    const tree = await this.load();
    if (!tree) return [new ErrorNode(this.loadError ?? 'unknown error')];
    if (!this.filterText) return this.unfilteredRoots(tree);
    if (!this.groupingOn) return this.flatFilteredRoots(tree);
    return this.groupedFilteredRoots(tree);
  }

  private toModNode = (m: Mod): ModNode => new ModNode(m, this.statuses?.get(m.name));

  private separatorChildren(element: SeparatorNode): ModlistNode[] {
    const mods = this.filterText && !this.matches(element.separator.name)
      ? element.mods.filter((m) => this.matches(m.name))
      : element.mods;
    return mods.map(this.toModNode);
  }

  private unfilteredRoots(tree: ModlistTree): ModlistNode[] {
    const ungroupedNodes = this.orderedMods(tree.ungrouped).map(this.toModNode);
    const groupNodes = this.orderedGroups(tree.groups).map(
      (g) => new SeparatorNode(g.separator, this.orderedMods(g.mods)),
    );
    const blocks = this.sortDescending ? [groupNodes, ungroupedNodes] : [ungroupedNodes, groupNodes];
    return [new CountNode(tree.activeCount, tree.installedCount), ...blocks[0], ...blocks[1]];
  }

  /** Priority-order a sibling list: file order (lowest priority first) unless
   *  `sortDescending`, mirroring MO2's clickable Priority-column sort. */
  private orderedMods(mods: Mod[]): Mod[] {
    return this.sortDescending ? [...mods].reverse() : mods;
  }

  private orderedGroups(groups: ModlistTree['groups']): ModlistTree['groups'] {
    return this.sortDescending ? [...groups].reverse() : groups;
  }

  private flatFilteredRoots(tree: ModlistTree): ModlistNode[] {
    const ungroupedNodes = this.orderedMods(tree.ungrouped);
    const groupedNodes = this.orderedGroups(tree.groups).flatMap((g) => this.orderedMods(g.mods));
    const blocks = this.sortDescending ? [groupedNodes, ungroupedNodes] : [ungroupedNodes, groupedNodes];
    return [...blocks[0], ...blocks[1]].filter((m) => this.matches(m.name)).map(this.toModNode);
  }

  private groupedFilteredRoots(tree: ModlistTree): ModlistNode[] {
    const ungroupedNodes = this.orderedMods(tree.ungrouped).filter((m) => this.matches(m.name)).map(this.toModNode);
    const groupNodes: ModlistNode[] = [];
    for (const g of this.orderedGroups(tree.groups)) {
      const sepNameMatches = this.matches(g.separator.name);
      const orderedGroupMods = this.orderedMods(g.mods);
      const matchingMods = sepNameMatches ? orderedGroupMods : orderedGroupMods.filter((m) => this.matches(m.name));
      if (sepNameMatches || matchingMods.length > 0) {
        groupNodes.push(new SeparatorNode(g.separator, matchingMods));
      }
    }
    const blocks = this.sortDescending ? [groupNodes, ungroupedNodes] : [ungroupedNodes, groupNodes];
    return [...blocks[0], ...blocks[1]];
  }

  private matches(name: string): boolean {
    return name.toLowerCase().includes(this.filterLower);
  }

  /** Toggle a mod's enabled state, writing through the source, then refresh. */
  async setModEnabled(modName: string, enabled: boolean): Promise<void> {
    await this.source.setEnabled(modName, enabled);
    this.refresh();
  }

  /** Persist the active profile and refresh the tree. */
  async switchProfile(name: string): Promise<void> {
    await this.source.setActiveProfile(name);
    this.refresh();
  }

  /** Flip the priority sort direction (ascending &lt;-&gt; descending) and refresh the tree. */
  toggleSortOrder(): void {
    this.sortDescending = !this.sortDescending;
    this.refresh();
  }

  private err(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }

  private async load(): Promise<ModlistTree | undefined> {
    if (this.tree) return this.tree;
    let entries: ModlistEntry[];
    try {
      entries = await this.source.readModlist();
    } catch (e) {
      this.loadError = this.err(e);
      this.log(`[ModListProvider] readModlist failed: ${this.loadError}`);
      return undefined;
    }
    this.loadError = undefined;
    this.cachedEntries = entries;
    this.tree = groupModlist(entries);
    if (this.instanceRoot) {
      try {
        const [index, vanillaMasters] = await Promise.all([
          buildFileConflictIndex(entries, this.instanceRoot),
          this.dataFolder.then((df) => readVanillaMasters(df, this.log)),
        ]);
        this.statuses = await computeModStatuses(entries, this.instanceRoot, index, vanillaMasters, this.log);
      } catch (e) {
        const message = this.err(e);
        this.log(`[ModListProvider] status computation failed: ${message}`);
        this.reporter?.report('warning', 'Could not compute mod conflict/missing-master status — badges may be inaccurate.', message);
        this.statuses = undefined;
      }
    }
    return this.tree;
  }
}

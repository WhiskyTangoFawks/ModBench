import * as vscode from 'vscode';
import type { IModlistSource, Mod, ModlistEntry, Separator } from './model';
import { groupModlist, type ModlistTree } from './modlistTree';
import { buildFileConflictIndex } from './fileConflictIndex';
import { computeModStatuses, type ModStatus, type ModStatusResult } from './statusChecker';
import { readVanillaMasters } from './vanillaMasters';

const DND_MIME = 'application/vnd.medit.modlist-node';

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

export type ModlistNode = CountNode | SeparatorNode | ModNode;

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
  private filterText = '';
  private filterLower = '';
  private groupingOn = true;
  private readonly log: (msg: string) => void;

  /** `instanceRoot`, when provided, enables status badges (Modbench-3):
   *  file-conflict index + missing-master/missing-mod checks against real
   *  files on disk. Omitted in tests that use an in-memory-only source. */
  constructor(
    private readonly source: IModlistSource,
    log?: (msg: string) => void,
    private readonly instanceRoot?: string,
  ) {
    this.log = log ?? (() => {});
  }

  refresh(): void {
    this.tree = undefined;
    this.cachedEntries = undefined;
    this.statuses = undefined;
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
    if (!node || node.kind === 'count') return;
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
    if (kind === 'mod') {
      if (target instanceof SeparatorNode) {
        await this.source.moveModToSeparator(name, target.separator.name);
      } else {
        await this.source.reorder(name, this.flatIndexOf(target));
      }
    } else {
      await this.source.reorderSeparatorBlock(name, this.flatIndexOf(target));
    }
    this.refresh();
  }

  private flatIndexOf(node: ModlistNode | undefined): number {
    if (!this.cachedEntries) return 0;
    if (!node) return this.cachedEntries.length;
    if (node.kind === 'count') return 0;
    if (node.kind === 'mod') {
      const idx = this.cachedEntries.findIndex((e) => e.kind === 'mod' && e.name === node.mod.name);
      return idx >= 0 ? idx : this.cachedEntries.length;
    }
    const idx = this.cachedEntries.findIndex(
      (e) => e.kind === 'separator' && e.name === node.separator.name,
    );
    return idx >= 0 ? idx : this.cachedEntries.length;
  }

  getTreeItem(element: ModlistNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: ModlistNode): Promise<ModlistNode[]> {
    if (element instanceof SeparatorNode) {
      const mods = this.filterText && !this.matches(element.separator.name)
        ? element.mods.filter((m) => this.matches(m.name))
        : element.mods;
      return mods.map((m) => new ModNode(m, this.statuses?.get(m.name)));
    }
    if (element) return [];

    const tree = await this.load();
    if (!tree) return [];

    if (!this.filterText) {
      return [
        new CountNode(tree.activeCount, tree.installedCount),
        ...tree.ungrouped.map((m) => new ModNode(m, this.statuses?.get(m.name))),
        ...tree.groups.map((g) => new SeparatorNode(g.separator, g.mods)),
      ];
    }

    if (!this.groupingOn) {
      const allMods = [...tree.ungrouped, ...tree.groups.flatMap((g) => g.mods)];
      return allMods.filter((m) => this.matches(m.name)).map((m) => new ModNode(m, this.statuses?.get(m.name)));
    }

    // groupingOn with active filter
    const roots: ModlistNode[] = [];
    roots.push(
      ...tree.ungrouped
        .filter((m) => this.matches(m.name))
        .map((m) => new ModNode(m, this.statuses?.get(m.name))),
    );
    for (const g of tree.groups) {
      const sepNameMatches = this.matches(g.separator.name);
      const matchingMods = sepNameMatches ? g.mods : g.mods.filter((m) => this.matches(m.name));
      if (sepNameMatches || matchingMods.length > 0) {
        roots.push(new SeparatorNode(g.separator, matchingMods));
      }
    }
    return roots;
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

  private async load(): Promise<ModlistTree | undefined> {
    if (this.tree) return this.tree;
    try {
      const entries = await this.source.readModlist();
      this.cachedEntries = entries;
      this.tree = groupModlist(entries);
      if (this.instanceRoot) {
        const [index, vanillaMasters] = await Promise.all([
          buildFileConflictIndex(entries, this.instanceRoot),
          readVanillaMasters(this.instanceRoot, this.log),
        ]);
        this.statuses = await computeModStatuses(entries, this.instanceRoot, index, vanillaMasters, this.log);
      }
      return this.tree;
    } catch (e) {
      this.log(`[ModListProvider] readModlist failed: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    }
  }
}

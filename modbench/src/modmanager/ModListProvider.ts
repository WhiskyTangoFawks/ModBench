import * as vscode from 'vscode';
import { join } from 'node:path';
import type { Mod, ModlistEntry, Separator } from './model';
import { groupModlist, type ModlistTree } from './modlistTree';
import type { ModStatus, ModStatusResult } from './statusChecker';
// Pure drop-index reconciliation, shared with PluginListProvider. A neutral
// home would be warranted if a third consumer appears; not worth the churn yet.
import { dropIndexForMove } from './mo2/pluginsText';
import type { Reporter } from './deployer';
import type { Instance, InstanceValue } from './instance';
import {
  moveModToSeparator as moveModToSeparatorCommand,
  reorderMod as reorderModCommand,
  reorderSeparatorBlock as reorderSeparatorBlockCommand,
  setModEnabled as setModEnabledCommand,
  type ModlistCommandResult,
} from './commands/modlist';

const DND_MIME = 'application/vnd.medit.modlist-node';

export interface ModListProviderOptions {
  /** Mods/separators in override order, per-mod conflict/override/missing status and the
   *  overwrite/ file count — the tree's only data input (ADR-0047). */
  instance: Pick<Instance, 'value' | 'subscribe' | 'sequence'>;
  log?: (msg: string) => void;
  reporter?: Reporter;
  /** Only for the pinned Overwrite row's resourceUri (Explorer reveal / the decoration
   *  provider's key) — never read from disk by this provider. */
  instanceRoot: string;
}

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

/** A non-'ok' status overlays a badge onto the icon, description, and tooltip. */
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

/** Pinned read-only leaf over the instance's `overwrite/` folder. Not a
 *  modlist.txt entry — no checkbox, no drag, no mod actions. Single-click and
 *  the sole context action both reveal the folder in the Explorer. */
export class OverwriteNode extends vscode.TreeItem {
  readonly kind = 'overwrite' as const;
  constructor(public readonly resourceUri: vscode.Uri, fileCount: number) {
    super('Overwrite', vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'overwrite';
    // No explicit icon or color here: the spec scopes the row's look to a reddish
    // tint applied by a FileDecorationProvider keyed on resourceUri; this node
    // only carries the resourceUri. Let VS Code render the folder icon.
    this.tooltip = `${fileCount} file(s) swept from Data/ — reassign in the Explorer or clear.`;
    this.command = {
      command: 'modbench.modList.overwrite.reveal',
      title: 'Open in Explorer',
      arguments: [this],
    };
  }
}

export type ModlistNode = CountNode | SeparatorNode | ModNode | OverwriteNode;

function isEntryNode(node: ModlistNode): node is ModNode | SeparatorNode {
  return node.kind === 'mod' || node.kind === 'separator';
}

/** Sidebar Mod List (Loadout) tree over an MO2 instance's active profile — rows, statuses and
 *  the overwrite count all read entirely from the Instance value (ADR-0047); this provider owns
 *  no cache or watcher over MO2's files itself. */
export class ModListProvider
  implements vscode.TreeDataProvider<ModlistNode>, vscode.TreeDragAndDropController<ModlistNode>, vscode.Disposable
{
  readonly dropMimeTypes = [DND_MIME] as const;
  readonly dragMimeTypes = [DND_MIME] as const;

  private readonly _onDidChangeTreeData = new vscode.EventEmitter<ModlistNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private tree?: ModlistTree;
  private cachedEntries?: ModlistEntry[];
  private filterText = '';
  private filterLower = '';
  private groupingOn = true;
  // View order only (no override weight). false (default) = losing end at top —
  // base/vanilla-adjacent mods on top, winning overrides at the bottom, matching
  // MO2's default. See modmanager/CONTEXT.md ("View order").
  private winningAtTop = false;
  private readonly log: (msg: string) => void;
  private readonly reporter?: Reporter;
  private readonly instanceRoot: string;
  private readonly instance: Pick<Instance, 'value' | 'subscribe' | 'sequence'>;
  private instanceValue: InstanceValue;
  private readonly instanceSubscription: vscode.Disposable;
  // Resolves once the Instance lands its first recompute. `sequence === 0` means "not read
  // yet", never "genuinely empty" — lets `getChildren()` await it instead of rendering early.
  private readonly firstValue: Promise<void>;
  private resolveFirstValue: (() => void) | undefined;

  constructor(options: ModListProviderOptions) {
    this.log = options.log ?? (() => {});
    this.reporter = options.reporter;
    this.instanceRoot = options.instanceRoot;
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

  /** Re-pulls `instance.value` rather than trusting the copy the last subscriber callback left:
   *  a caller forcing a resync (a failed write, a gesture's own callback) gets whatever the
   *  Instance is currently holding, not a snapshot that predates it. */
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

  handleDrag(
    source: readonly ModlistNode[],
    dataTransfer: vscode.DataTransfer,
    _token: vscode.CancellationToken,
  ): void {
    const node = source.at(0);
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
    // Neither the count summary nor the pinned Overwrite fixture is a modlist.txt
    // position — dropping onto them must not fall through to "move to end".
    if (target?.kind === 'count' || target?.kind === 'overwrite') return;
    const { kind, name } = payload.value as { kind: 'mod' | 'separator'; name: string };
    // Resync against disk afterwards so a failed mutation never leaves a phantom reorder on
    // screen (ADR-0026).
    await this.applyDrop(kind, name, target);
    this.invalidate();
  }

  private async applyDrop(kind: 'mod' | 'separator', name: string, target: ModlistNode | undefined): Promise<void> {
    // A drop hands us the *pre-removal* target, but moveModInText counts toIndex among the
    // entries with the moved lines already removed, so a moved entry above the target shifts
    // it left. A separator drops its whole block.
    const order = this.cachedEntries?.map((e) => e.name) ?? [];
    const targetName = this.targetName(target);
    const profile = this.instanceValue.activeProfile;
    if (kind === 'mod') {
      if (target instanceof SeparatorNode) {
        await this.runMutation('moveModToSeparator', () =>
          moveModToSeparatorCommand(this.instanceRoot, profile, name, target.separator.name));
      } else {
        await this.runMutation('reorder', () =>
          reorderModCommand(this.instanceRoot, profile, name, this.dropToIndex(order, [name], targetName)));
      }
    } else {
      await this.runMutation('reorderSeparatorBlock', () =>
        reorderSeparatorBlockCommand(this.instanceRoot, profile, name, this.dropToIndex(order, this.separatorBlockNames(name), targetName)),
      );
    }
  }

  // Swallows the failure (thrown, or a `{ applied: false }` refusal) rather than rethrowing, so
  // `handleDrop` still reaches its resync.
  private async runMutation(
    operation: 'reorder' | 'moveModToSeparator' | 'reorderSeparatorBlock',
    mutate: () => Promise<ModlistCommandResult>,
  ): Promise<void> {
    try {
      const outcome = await mutate();
      if (outcome.applied) return;
      this.log(`[ModListProvider] ${operation} failed: ${outcome.refusal}`);
      this.reporter?.report('error', 'Failed to reorder mods.', outcome.refusal);
    } catch (e) {
      const message = this.err(e);
      this.log(`[ModListProvider] ${operation} failed: ${message}`);
      this.reporter?.report('error', 'Failed to reorder mods.', message);
    }
  }

  // "Drop X onto Y" gives X the visual slot of Y: before Y in the winning-first file when
  // winning-at-top, after it when the view runs opposite.
  private dropToIndex(order: string[], movedNames: string[], targetName: string | undefined): number {
    const before = dropIndexForMove(order, movedNames, targetName);
    if (this.winningAtTop) return before;
    return targetName === undefined ? 0 : before + 1;
  }

  private targetName(node: ModlistNode | undefined): string | undefined {
    if (!node || !isEntryNode(node)) return undefined;
    return node.kind === 'mod' ? node.mod.name : node.separator.name;
  }

  // A separator's members are the entries *preceding* it, back to the previous separator.
  private separatorBlockNames(sepName: string): string[] {
    const entries = this.cachedEntries ?? [];
    const idx = entries.findIndex((e) => e.kind === 'separator' && e.name === sepName);
    if (idx < 0) return [sepName];
    let start = idx - 1;
    while (start >= 0 && entries[start].kind !== 'separator') start--;
    const names = entries.slice(start + 1, idx).map((e) => e.name);
    names.push(sepName);
    return names;
  }

  getTreeItem(element: ModlistNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: ModlistNode): Promise<ModlistNode[]> {
    if (element instanceof SeparatorNode) return this.separatorChildren(element);
    if (element) return [];
    await this.firstValue; // never render before the Instance has actually read once

    const tree = this.ensureLoaded();
    const roots = this.rootNodes(tree);
    const overwrite = this.overwriteNode();
    return overwrite ? [...roots, overwrite] : roots;
  }

  private ensureLoaded(): ModlistTree {
    if (!this.tree) {
      this.cachedEntries = [...this.instanceValue.mods];
      this.tree = groupModlist(this.cachedEntries);
    }
    return this.tree;
  }

  private rootNodes(tree: ModlistTree): ModlistNode[] {
    if (!this.filterText) return this.unfilteredRoots(tree);
    if (!this.groupingOn) return this.flatFilteredRoots(tree);
    return this.groupedFilteredRoots(tree);
  }

  // Appended last, outside grouping and sort: a fixture over the folder, not a modlist.txt entry.
  private overwriteNode(): OverwriteNode | undefined {
    const count = this.instanceValue.overwriteFileCount;
    if (count <= 0) return undefined;
    return new OverwriteNode(vscode.Uri.file(join(this.instanceRoot, 'overwrite')), count);
  }

  private toModNode = (m: Mod): ModNode => new ModNode(m, this.instanceValue.modStatuses.get(m.name));

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
    const blocks = this.winningAtTop ? [ungroupedNodes, groupNodes] : [groupNodes, ungroupedNodes];
    return [new CountNode(tree.activeCount, tree.installedCount), ...blocks[0], ...blocks[1]];
  }

  // modlist.txt is winning-first, so the default losing-at-top view reverses it. View order only.
  private orderedMods(mods: Mod[]): Mod[] {
    return this.winningAtTop ? mods : [...mods].reverse();
  }

  private orderedGroups(groups: ModlistTree['groups']): ModlistTree['groups'] {
    return this.winningAtTop ? groups : [...groups].reverse();
  }

  private flatFilteredRoots(tree: ModlistTree): ModlistNode[] {
    const ungroupedNodes = this.orderedMods(tree.ungrouped);
    const groupedNodes = this.orderedGroups(tree.groups).flatMap((g) => this.orderedMods(g.mods));
    const blocks = this.winningAtTop ? [ungroupedNodes, groupedNodes] : [groupedNodes, ungroupedNodes];
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
    const blocks = this.winningAtTop ? [ungroupedNodes, groupNodes] : [groupNodes, ungroupedNodes];
    return [...blocks[0], ...blocks[1]];
  }

  private matches(name: string): boolean {
    return name.toLowerCase().includes(this.filterLower);
  }

  async setModEnabled(modName: string, enabled: boolean): Promise<void> {
    const outcome = await setModEnabledCommand(this.instanceRoot, this.instanceValue.activeProfile, modName, enabled);
    if (!outcome.applied) throw new Error(outcome.refusal);
    this.invalidate();
  }

  /** Presentation only — never changes which mod wins a conflict. */
  toggleViewDirection(): void {
    this.winningAtTop = !this.winningAtTop;
    this.invalidate();
  }

  private err(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }
}

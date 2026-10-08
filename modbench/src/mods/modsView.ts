import * as vscode from 'vscode';
import type { Instance, InstanceValue, InstanceView } from '../instanceLoader/instance';
import type { InstallAccess } from '../install/install';
import type { Reporter } from '../ports/reporter';
import type { AskQuestion } from '../ports/dialog';
import type { MoveToTrash } from '../ports/trash';
import type { CopyValueAdapter } from '../drivingLib/copyValue';
import type { NexusModRow } from '../drivingLib/inFocusedView';
import { errorMessage } from '../ports/errorMessage';
import { messageLine, registerNameFilter, type NameFilter } from '../drivingLib/nameFilter';
import { registerSortDirectionToggle } from '../drivingLib/sortDirectionToggle';
import type { ModSync } from './modSync';
import { modsKeyContext } from './gestureEntry';
import { onModCheckboxChanged } from './modCheckboxHandler';
import { ModListProvider, OverwriteNode, type ModlistNode } from './ModListProvider';
import { registerModDecorations } from './modDecorations';
import { registerModInstallCommands } from './installCommands';
import { registerCompareFileCommand } from './compareFile';
import { registerGoToModCommand } from './goToMod';
import { registerConflictTable } from './conflictTableEditor';
import {
  modsCopyValueText, registerCreateEmptyModCommand, registerFileExclusionCommands, registerModContextCommands, registerModEnableCommands,
  registerModMoveCommand, registerOpenFolderCommand, registerSeparatorCommands, registerViewOnNexusCommand,
} from './modManagementCommands';

interface ModsViewDeps {
  instance: InstanceView & Pick<Instance, 'refresh' | 'sameCopies'>;
  access: InstallAccess;
  log: (line: string) => void;
  reporterFor: (tag: string) => Reporter;
  ask: AskQuestion;
  trash: MoveToTrash;
  extensionUri: vscode.Uri;
  warnIfFomod: (name: string, isFomod: boolean) => void;
  downloadInstall: Parameters<typeof registerModInstallCommands>[0]['downloadInstall'];
  /** The one selected mod row with a Nexus id in the focused Mods or Downloads view, for the palette. */
  nexusRow: () => NexusModRow | undefined;
  /** Mod sync, whose failure the view's message line says. */
  modSync: ModSync;
}

interface ModsView extends vscode.Disposable {
  view: vscode.TreeView<ModlistNode>;
  nameFilter: NameFilter;
  copyValue: CopyValueAdapter;
}

/** Tree, filter and count readout together, because the view's description and message line
 *  each have exactly one owner. Split apart, a row change and a filter keystroke race for them and
 *  the loser silently vanishes. */
export function createModsView(deps: ModsViewDeps): ModsView {
  const { instance, access, log, modSync, reporterFor, ask, trash } = deps;
  const provider = new ModListProvider({ instance });
  const view = vscode.window.createTreeView('modbench.modList', {
    treeDataProvider: provider,
    canSelectMany: true,
    showCollapseAll: true,
    dragAndDropController: provider,
  });
  const nameFilter = registerNameFilter({
    view,
    object: 'modbench.mod',
    placeholder: 'Filter mods…',
    setFilter: (text, grouping) => provider.setFilter(text, grouping),
    hasRows: async () => (await provider.getChildren()).some((n) => !(n instanceof OverwriteNode) || n.lists()),
    toggle: { icon: 'list-tree', label: 'Group by separator' },
    termPlacement: 'afterBase',
    viewMessage: () => messageLine(provider.viewMessage(), modSync.message()),
    standingMessage: () => provider.lastGoodReadMessage(),
    onRowsChanged: provider.onDidChangeTreeData,
    onViewMessageChanged: (listener) => modSync.onMessageChanged(listener),
  });
  const showCount = () => nameFilter.setBaseDescription(provider.description());
  showCount();
  nameFilter.refresh();
  const showKeyContext = () => {
    for (const [name, value] of Object.entries(modsKeyContext(view.selection, (row) => provider.isEnabled(row)))) {
      void vscode.commands.executeCommand('setContext', `modbench.mod.${name}`, value);
    }
  };
  showKeyContext();
  const expand = () => void expandFilteredRows(view, provider, log);
  // Disposed in order: what reads the tree and the view goes before them.
  const disposable = vscode.Disposable.from(
    provider.onDidChangeTreeData(showCount),
    view.onDidChangeSelection(showKeyContext),
    provider.onDidChangeTreeData(showKeyContext),
    provider.onDidChangeTreeData(expand),
    view.onDidChangeVisibility(expand),
    view.onDidChangeCheckboxState(onModCheckboxChanged),
    ...registerModDecorations(instance, vscode.workspace),
    ...registerModContextCommands({
      adapter: access.adapter, instance, viewSelection: () => view.selection, reporter: reporterFor('mod.uninstall'), ask, trash,
      log,
    }),
    ...registerModEnableCommands(access.adapter, instance, () => view.selection, reporterFor('mod.enableDisable')),
    ...registerFileExclusionCommands(access.adapter, instance, () => view.selection, reporterFor('mod.excludeFile')),
    registerModMoveCommand(
      access.adapter, instance, { selection: () => view.selection, direction: () => provider.viewDirection() }, reporterFor('mod.move')),
    ...registerSeparatorCommands(access.adapter, instance, reporterFor('separator'), ask, trash, () => view.selection),
    registerCreateEmptyModCommand(access.adapter, instance, reporterFor('mod.createEmpty')),
    registerOpenFolderCommand(instance, reporterFor('mod.openFolder'), () => view.selection),
    registerGoToModCommand(instance, reporterFor('mod.goToMod'), {
      selection: () => view.selection,
      rowFor: (origin) => provider.rowFor(origin),
      reveal: (row) => view.reveal(row, { select: true, focus: true }),
    }),
    registerCompareFileCommand(instance, reporterFor('mod.compareFile'), () => view.selection),
    ...registerConflictTable(instance, deps.extensionUri, () => view.selection, reporterFor('mod.openConflicts'), vscode.workspace),
    vscode.commands.registerCommand('modbench.mod.sync', (value: InstanceValue) => modSync.run(value.modSyncArguments)),
    ...registerModInstallCommands({
      access, instance, reporterFor, warnIfFomod: deps.warnIfFomod, downloadInstall: deps.downloadInstall,
    }),
    registerViewOnNexusCommand(instance, reporterFor('mod.viewOnNexus'), deps.nexusRow),
    ...registerSortDirectionToggle('mod', provider),
    nameFilter,
    view,
    provider,
  );
  return {
    view, nameFilter, copyValue: { text: modsCopyValueText(() => view.selection), reporterTag: 'mod.copyValue' },
    dispose: () => { disposable.dispose(); },
  };
}

// VS Code keeps the expansion it remembers for a known row identity over the provider's state, so
// only a reveal opens a row the filter shows for its matches. A reveal also opens a hidden view.
async function expandFilteredRows(
  view: vscode.TreeView<ModlistNode>, provider: ModListProvider, log: (line: string) => void, parent?: ModlistNode,
): Promise<void> {
  if (!view.visible) return;
  for (const row of await provider.getChildren(parent)) {
    if (row.collapsibleState !== vscode.TreeItemCollapsibleState.Expanded) continue;
    try {
      await view.reveal(row, { select: false, focus: false, expand: true });
    } catch (e) {
      log(`Could not expand "${typeof row.label === 'string' ? row.label : row.id}" for the filter: ${errorMessage(e)}`);
      continue;
    }
    await expandFilteredRows(view, provider, log, row);
  }
}

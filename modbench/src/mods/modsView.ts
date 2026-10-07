import * as vscode from 'vscode';
import type { InstanceView } from '../instanceLoader/instance';
import { errorMessage } from '../ports/errorMessage';
import { messageLine, registerNameFilter, type NameFilter } from '../drivingLib/nameFilter';
import { registerSortDirectionToggle } from '../drivingLib/sortDirectionToggle';
import type { ModSync } from './modSync';
import { modsKeyContext } from './gestureEntry';
import { onModCheckboxChanged } from './modCheckboxHandler';
import { ModListProvider, OverwriteNode, type ModlistNode } from './ModListProvider';

export interface ModsViewDeps {
  instance: InstanceView;
  log: (line: string) => void;
  /** Mod sync, whose failure the view's message line says. */
  modSync: ModSync;
}

export interface ModsView extends vscode.Disposable {
  provider: ModListProvider;
  view: vscode.TreeView<ModlistNode>;
  nameFilter: NameFilter;
}

/** Tree, filter and count readout together, because the view's description and message line
 *  each have exactly one owner. Split apart, a row change and a filter keystroke race for them and
 *  the loser silently vanishes. */
export function createModsView({ instance, log, modSync }: ModsViewDeps): ModsView {
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
    ...registerSortDirectionToggle('mod', provider),
    nameFilter,
    view,
    provider,
  );
  return { provider, view, nameFilter, dispose: () => { disposable.dispose(); } };
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

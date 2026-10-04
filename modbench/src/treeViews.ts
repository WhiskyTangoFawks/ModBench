// The instance-side trees themselves: a TreeView, its name filter and the disposables' owner are
// the composition root's, so they sit beside it rather than in the views they render.

import * as vscode from 'vscode';
import { ModListProvider, ModNode, OverwriteNode, type ModlistNode } from './mods/ModListProvider';
import type { NexusModRow } from './mods/modManagementCommands';
import { errorMessage } from './ports/errorMessage';
import { DownloadNode } from './downloads/DownloadsProvider';
import type { Own } from './session';
import { messageLine, registerNameFilter, type NameFilter, type SyncMessage } from './drivingLib/nameFilter';
import { modsKeyContext } from './mods/gestureEntry';

/** Tree, filter and count readout together, because the view's description and message line
 *  each have exactly one owner. Split apart, a row change and a filter keystroke race for them and
 *  the loser silently vanishes. */
export function createModListView(
  own: Own,
  modListProvider: ModListProvider,
  log: (line: string) => void,
  modSync: SyncMessage,
): { modListView: vscode.TreeView<ModlistNode>; modListFilter: NameFilter } {
  const modListView = own(vscode.window.createTreeView('modbench.modList', {
    treeDataProvider: modListProvider,
    canSelectMany: true,
    showCollapseAll: true,
    dragAndDropController: modListProvider,
  }));
  const modListFilter = own(registerNameFilter({
    view: modListView,
    object: 'modbench.mod',
    placeholder: 'Filter mods…',
    setFilter: (text, grouping) => modListProvider.setFilter(text, grouping),
    hasRows: async () => (await modListProvider.getChildren()).some((n) => !(n instanceof OverwriteNode) || n.lists()),
    toggle: { icon: 'list-tree', label: 'Group by separator' },
    termPlacement: 'afterBase',
    viewMessage: () => messageLine(modListProvider.viewMessage(), modSync.message()),
    standingMessage: () => modListProvider.lastGoodReadMessage(),
    onRowsChanged: modListProvider.onDidChangeTreeData,
    onViewMessageChanged: (listener) => modSync.onMessageChanged(listener),
  }));
  const showCount = () => modListFilter.setBaseDescription(modListProvider.description());
  showCount();
  modListFilter.refresh();
  own(modListProvider.onDidChangeTreeData(showCount));
  const showKeyContext = () => {
    const context = modsKeyContext(modListView.selection, (row) => modListProvider.isEnabled(row));
    for (const [name, value] of Object.entries(context)) {
      void vscode.commands.executeCommand('setContext', `modbench.mod.${name}`, value);
    }
  };
  showKeyContext();
  own(modListView.onDidChangeSelection(showKeyContext));
  own(modListProvider.onDidChangeTreeData(showKeyContext));
  const expand = () => void expandFilteredRows(modListView, modListProvider, log);
  own(modListProvider.onDidChangeTreeData(expand));
  own(modListView.onDidChangeVisibility(expand));
  return { modListView, modListFilter };
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

type SelectableView = Pick<vscode.TreeView<unknown>, 'selection' | 'onDidChangeSelection'>;

/** No stable API names the focused view, so the palette's view on Nexus opens the row selected in
 *  the view last selected in, and `modbench.mod.nexusRowIn` names that view while it has one. */
export function nexusRowInLastSelectedView(
  own: Own, views: readonly { id: string; view: SelectableView }[],
): () => NexusModRow | undefined {
  let last: SelectableView | undefined;
  const nexusRow = (): NexusModRow | undefined => {
    const [only, ...rest] = last?.selection ?? [];
    const row = only instanceof ModNode || only instanceof DownloadNode ? only : undefined;
    return rest.length === 0 && row?.nexusModId !== undefined ? row : undefined;
  };
  for (const { id, view } of views) {
    own(view.onDidChangeSelection(() => {
      last = view;
      void vscode.commands.executeCommand('setContext', 'modbench.mod.nexusRowIn', nexusRow() && id);
    }));
  }
  return nexusRow;
}

/** No stable API names the focused view, so a palette gesture views offer takes the selection of
 *  the view last selected in, and `contextKey`, when given, names that view. */
export function lastSelectedViewSelection(
  own: Own, views: readonly { id: string; view: SelectableView }[], contextKey?: string,
): () => readonly unknown[] {
  let last: SelectableView | undefined;
  for (const { id, view } of views) {
    own(view.onDidChangeSelection(() => {
      last = view;
      if (contextKey !== undefined) void vscode.commands.executeCommand('setContext', contextKey, id);
    }));
  }
  return () => last?.selection ?? [];
}

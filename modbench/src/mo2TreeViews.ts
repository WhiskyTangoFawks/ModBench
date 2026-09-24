// The MO2-side trees themselves: a TreeView, its name filter and the disposables' owner are the
// composition root's, so they sit beside it rather than in the views they render.

import * as vscode from 'vscode';
import { ModListProvider, OverwriteNode, SeparatorNode, type ModlistNode } from './mods/ModListProvider';
import { errorMessage } from './ports/errorMessage';
import {
  registerDownloadsHiddenToggleCommands, registerDownloadsMultiRowCommands,
  registerDownloadsSingleRowCommands, registerDownloadsSortCommand, type DownloadInstallDeps,
} from './downloads/DownloadsPanel';
import { DownloadsProvider } from './downloads/DownloadsProvider';
import { ExcludedDownloadDecorationProvider } from './downloads/ExcludedDownloadDecorationProvider';
import type { InstanceView } from './instanceLoader/instance';
import type { Own } from './session';
import type { Reporter } from './ports/reporter';
import type { AskQuestion } from './ports/dialog';
import type { MoveToTrash } from './ports/trash';
import { registerNameFilter } from './nameFilter';

/** Tree, filter and count readout together, because the view's description and message line
 *  each have exactly one owner. Split apart, a row change and a filter keystroke race for them and
 *  the loser silently vanishes. */
export function createModListView(
  own: Own,
  modListProvider: ModListProvider,
  log: (line: string) => void,
): { modListView: vscode.TreeView<ModlistNode> } {
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
    // Overwrite survives every filter and is no match, so it is not evidence that the term matched.
    hasRows: async () => (await modListProvider.getChildren()).some((n) => !(n instanceof OverwriteNode)),
    toggle: { icon: 'list-tree', label: 'Group by separator' },
    termPlacement: 'afterBase',
    unfilteredMessage: () => modListProvider.emptyListMessage(),
    onRowsChanged: modListProvider.onDidChangeTreeData,
  }));
  const showCount = () => modListFilter.setBaseDescription(modListProvider.description());
  showCount();
  modListFilter.refresh();
  own(modListProvider.onDidChangeTreeData(showCount));
  const expand = () => void expandFilteredSeparators(modListView, modListProvider, log);
  own(modListProvider.onDidChangeTreeData(expand));
  own(modListView.onDidChangeVisibility(expand));
  return { modListView };
}

// VS Code keeps the expansion it remembers for a known row identity over the provider's
// collapsible state, so only a reveal opens a separator the filter shows for its matching mods.
// A reveal also opens a hidden view.
async function expandFilteredSeparators(
  view: vscode.TreeView<ModlistNode>, provider: ModListProvider, log: (line: string) => void,
): Promise<void> {
  if (!view.visible) return;
  for (const row of await provider.getChildren()) {
    if (!(row instanceof SeparatorNode) || row.collapsibleState !== vscode.TreeItemCollapsibleState.Expanded) continue;
    try {
      await view.reveal(row, { select: false, focus: false, expand: true });
    } catch (e) {
      log(`Could not expand "${row.separator.name}" for the filter: ${errorMessage(e)}`);
    }
  }
}

/** Returns the live provider alongside its disposables, so integration tests can reach it.
 *  Rows come entirely from the Instance value (ADR-0015); no own scan or watcher here. */
export function registerDownloadsView(
  own: Own,
  instanceRoot: string,
  instance: InstanceView,
  reporter: Reporter,
  ask: AskQuestion,
  trash: MoveToTrash,
  install: DownloadInstallDeps,
): DownloadsProvider {
  const downloadsProvider = own(new DownloadsProvider({ instance })); // disposes its Instance subscriptions
  const downloadsView = own(vscode.window.createTreeView('modbench.downloads', {
    treeDataProvider: downloadsProvider,
    canSelectMany: true,
  }));
  // Dims excluded rows once Show excluded is on. Refreshed on every rows change, so exclude and
  // include reach the dim without waiting on VS Code's own re-query.
  const excludedDecorations = new ExcludedDownloadDecorationProvider(
    instance.value.paths.downloadsDir, () => downloadsProvider.excludedNames());
  own(vscode.window.registerFileDecorationProvider(excludedDecorations));
  own(downloadsProvider.onDidChangeTreeData(() => excludedDecorations.refresh()));
  own(registerNameFilter({
    view: downloadsView, object: 'modbench.downloadedFile', placeholder: 'Filter downloads…',
    setFilter: (text) => downloadsProvider.setFilter(text),
    hasRows: async () => (await downloadsProvider.getChildren()).length > 0,
    onRowsChanged: downloadsProvider.onDidChangeTreeData,
  }));
  // package.json's viewsWelcome gates the all-excluded message on this key (downloads.md,
  // States, story 2), recomputed on every row change so a disk edit reaches it too.
  const updateAllExcludedContext = () =>
    void vscode.commands.executeCommand('setContext', 'modbench.downloadedFile.allExcluded', downloadsProvider.allExcluded());
  updateAllExcludedContext();
  own(downloadsProvider.onDidChangeTreeData(updateAllExcludedContext));
  own(registerDownloadsSortCommand(downloadsProvider));
  for (const disposable of [
    ...registerDownloadsHiddenToggleCommands(downloadsProvider),
    ...registerDownloadsSingleRowCommands(instanceRoot, instance, reporter, install),
    ...registerDownloadsMultiRowCommands(instanceRoot, reporter, ask, trash),
  ]) own(disposable);
  return downloadsProvider;
}

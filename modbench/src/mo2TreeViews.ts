// The MO2-side trees themselves: a TreeView, its name filter and the disposables' owner are the
// composition root's, so they sit beside it rather than in the views they render.

import * as vscode from 'vscode';
import { ModListProvider, OverwriteNode, SeparatorNode, type ModlistNode } from './mods/ModListProvider';
import { errorMessage } from './ports/errorMessage';
import {
  registerDownloadsExcludedToggleCommands, registerDownloadsMultiRowCommands,
  registerDownloadsSingleRowCommands, registerDownloadsSortCommand, type DownloadInstallDeps,
} from './downloads/DownloadsPanel';
import { DownloadNode, DownloadsProvider, type DownloadsTreeNode } from './downloads/DownloadsProvider';
import { ExcludedDownloadDecorationProvider } from './downloads/ExcludedDownloadDecorationProvider';
import type { InstanceView } from './instanceLoader/instance';
import type { Own } from './session';
import type { Reporter } from './ports/reporter';
import type { AskQuestion } from './ports/dialog';
import type { MoveToTrash } from './ports/trash';
import { messageLine, registerNameFilter } from './nameFilter';
import { modsKeyContext } from './mods/gestureEntry';
import type { SyncMessage } from './syncFailureReport';

/** Tree, filter and count readout together, because the view's description and message line
 *  each have exactly one owner. Split apart, a row change and a filter keystroke race for them and
 *  the loser silently vanishes. */
export function createModListView(
  own: Own,
  modListProvider: ModListProvider,
  log: (line: string) => void,
  modSync: SyncMessage,
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
    viewMessage: () => messageLine(modListProvider.emptyListMessage(), modSync.message()),
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

/** The selection of whichever view changed its selection last, read as that view holds it now:
 *  the palette hands a command no row, and no stable API names the focused view. */
export function selectedInLastSelectedView(
  own: Own,
  views: readonly Pick<vscode.TreeView<unknown>, 'selection' | 'onDidChangeSelection'>[],
): () => readonly unknown[] {
  let last: Pick<vscode.TreeView<unknown>, 'selection'> | undefined;
  for (const view of views) own(view.onDidChangeSelection(() => { last = view; }));
  return () => last?.selection ?? [];
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
): { downloadsProvider: DownloadsProvider; downloadsView: vscode.TreeView<DownloadsTreeNode> } {
  const downloadsProvider = own(new DownloadsProvider({ instance })); // disposes its Instance subscriptions
  const downloadsView = own(vscode.window.createTreeView('modbench.downloads', {
    treeDataProvider: downloadsProvider,
    canSelectMany: true,
  }));
  // Dims excluded rows once Show excluded is on. VS Code never re-queries a decoration provider
  // on its own, so this refreshes it on every rows change — exclude, include and a disk edit alike.
  const excludedDecorations = new ExcludedDownloadDecorationProvider(
    () => instance.value.paths.downloadsDir, () => downloadsProvider.excludedNames());
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
  const updateSingleNexusFileContext = () => {
    const [only, ...rest] = downloadsView.selection;
    const single = only?.kind === 'download' && only.nexusModId !== undefined && rest.length === 0;
    void vscode.commands.executeCommand('setContext', 'modbench.downloadedFile.singleNexusFile', single);
  };
  updateSingleNexusFileContext();
  own(downloadsView.onDidChangeSelection(updateSingleNexusFileContext));
  own(registerDownloadsSortCommand(downloadsProvider));
  for (const disposable of [
    ...registerDownloadsExcludedToggleCommands(downloadsProvider),
    ...registerDownloadsSingleRowCommands(instanceRoot, instance, reporter, install),
    ...registerDownloadsMultiRowCommands(
      instance, reporter, ask, trash, install.log,
      () => downloadsView.selection.filter((row): row is DownloadNode => row.kind === 'download'),
    ),
  ]) own(disposable);
  return { downloadsProvider, downloadsView };
}

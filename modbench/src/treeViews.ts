// The instance-side trees themselves: a TreeView, its name filter and the disposables' owner are
// the composition root's, so they sit beside it rather than in the views they render.

import * as vscode from 'vscode';
import { ModListProvider, ModNode, OverwriteNode, type ModlistNode } from './mods/ModListProvider';
import type { NexusModRow } from './mods/modManagementCommands';
import { errorMessage } from './ports/errorMessage';
import {
  installDownloadedFile, registerDownloadsExcludedToggleCommands, registerDownloadsMultiRowCommands,
  registerDownloadsSingleRowCommands, registerDownloadsSortCommand, type DownloadInstallDeps,
} from './downloads/DownloadsPanel';
import { DownloadNode, DownloadsProvider, type DownloadsTreeNode } from './downloads/DownloadsProvider';
import { ExcludedDownloadDecorationProvider } from './downloads/ExcludedDownloadDecorationProvider';
import { downloadsKeyContext } from './downloads/keyContext';
import type { DownloadFile, InstanceView } from './instanceLoader/instance';
import type { DownloadsAccess } from './downloadsCommands/downloads';
import type { InstallAccess } from './install/install';
import type { Own } from './session';
import type { Reporter } from './ports/reporter';
import type { AskQuestion } from './ports/dialog';
import type { MoveToTrash } from './ports/trash';
import { messageLine, registerNameFilter, type NameFilter } from './nameFilter';
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

export interface FocusedView {
  id(): string | undefined;
  /** Selecting in `view` makes it the focused one. */
  follow(id: string, view: SelectableView): vscode.Disposable;
  /** A surface that is no tree says it has the focus. */
  enter(id: string): void;
}

/** No stable API names the focused view, so it is the one last selected in or entered: copy
 *  value and the name filter, which every list offers, act on it. */
export function createFocusedView(): FocusedView {
  let last: string | undefined;
  return {
    id: () => last,
    follow: (id, view) => view.onDidChangeSelection(() => { last = id; }),
    enter: (id) => { last = id; },
  };
}

export interface DownloadsViewDeps {
  own: Own;
  access: DownloadsAccess & InstallAccess;
  instance: InstanceView;
  reporter: Reporter;
  ask: AskQuestion;
  trash: MoveToTrash;
  install: DownloadInstallDeps;
}

/** Returns the live provider alongside its disposables, so integration tests can reach it.
 *  Rows come from the Instance value alone (ADR-0015). */
export function registerDownloadsView(
  { own, access, instance, reporter, ask, trash, install }: DownloadsViewDeps,
): {
  downloadsProvider: DownloadsProvider; downloadsView: vscode.TreeView<DownloadsTreeNode>; downloadsFilter: NameFilter;
  installDownloaded: (file: DownloadFile) => Promise<boolean>;
} {
  const downloadsProvider = own(new DownloadsProvider({ instance, log: install.log })); // disposes its Instance subscriptions
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
  const downloadsFilter = own(registerNameFilter({
    view: downloadsView, object: 'modbench.downloadedFile', placeholder: 'Filter downloads…',
    setFilter: (text) => downloadsProvider.setFilter(text),
    hasRows: async () => (await downloadsProvider.getChildren()).length > 0,
    viewMessage: () => downloadsProvider.viewMessage(),
    standingMessage: () => downloadsProvider.viewMessage(),
    onRowsChanged: downloadsProvider.onDidChangeTreeData,
  }));
  // package.json's viewsWelcome gates the all-excluded message on this key (downloads.md,
  // States, story 2), recomputed on every row change so a disk edit reaches it too.
  const updateAllExcludedContext = () =>
    void vscode.commands.executeCommand('setContext', 'modbench.downloadedFile.allExcluded', downloadsProvider.allExcluded());
  updateAllExcludedContext();
  own(downloadsProvider.onDidChangeTreeData(updateAllExcludedContext));
  const showKeyContext = () => {
    for (const [name, value] of Object.entries(downloadsKeyContext(downloadsView.selection))) {
      void vscode.commands.executeCommand('setContext', `modbench.downloadedFile.${name}`, value);
    }
  };
  showKeyContext();
  own(downloadsView.onDidChangeSelection(showKeyContext));
  own(downloadsProvider.onDidChangeTreeData(showKeyContext));
  own(registerDownloadsSortCommand(downloadsProvider));
  for (const disposable of [
    ...registerDownloadsExcludedToggleCommands(downloadsProvider),
    ...registerDownloadsSingleRowCommands(reporter, () => downloadsView.selection),
    ...registerDownloadsMultiRowCommands(access, reporter, ask, trash, install.log, () => downloadsView.selection, downloadsProvider),
  ]) own(disposable);
  const installDownloaded = (file: DownloadFile) => installDownloadedFile(file, access, instance, reporter, install);
  return { downloadsProvider, downloadsView, downloadsFilter, installDownloaded };
}

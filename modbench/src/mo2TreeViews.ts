// The MO2-side trees themselves: a TreeView, its name filter and the disposables' owner are the
// composition root's, so they sit beside it rather than in the views they render.

import * as vscode from 'vscode';
import { ModListProvider, OverwriteNode, type ModlistNode } from './mods/ModListProvider';
import {
  registerDownloadsHiddenToggleCommands, registerDownloadsMultiRowCommands,
  registerDownloadsSingleRowCommands, registerDownloadsSortCommand, type DownloadInstallDeps,
} from './downloads/DownloadsPanel';
import { DownloadsProvider } from './downloads/DownloadsProvider';
import { HiddenDownloadDecorationProvider } from './downloads/HiddenDownloadDecorationProvider';
import type { Instance, InstanceView } from './instanceLoader/instance';
import type { Own } from './session';
import type { Reporter } from './ports/reporter';
import type { AskQuestion } from './ports/dialog';
import { registerNameFilter } from './nameFilter';

/** Tree, filter and profile readout together, because the view's description has exactly one
 *  owner. Split apart, a profile update and a filter keystroke race for that property and the
 *  loser silently vanishes. */
export function createModListView(
  own: Own,
  modListProvider: ModListProvider,
  instance: Pick<Instance, 'value' | 'subscribe'>,
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
    // The pinned Overwrite row sits outside all filtering (it is a fixture over the folder, not
    // a modlist entry), so it is not evidence that the term matched anything.
    hasRows: async () => (await modListProvider.getChildren()).some((n) => !(n instanceof OverwriteNode)),
    toggle: { icon: 'list-tree', label: 'Group by separator' },
    onRowsChanged: modListProvider.onDidChangeTreeData,
  }));
  const showProfile = () => modListFilter.setBaseDescription(instance.value.activeProfile);
  showProfile();
  // A profile switch rewrites ModOrganizer.ini, which the Instance watches — the recompute it
  // lands is what moves this readout, not the gesture.
  own(instance.subscribe(showProfile));
  return { modListView };
}
/** Returns the live provider alongside its disposables, so integration tests can reach it.
 *  Rows come entirely from the Instance value (ADR-0015); no own scan or watcher here. */
export function registerDownloadsView(
  own: Own,
  instanceRoot: string,
  instance: InstanceView,
  reporter: Reporter,
  ask: AskQuestion,
  install: DownloadInstallDeps,
): DownloadsProvider {
  const downloadsProvider = own(new DownloadsProvider({ instance })); // disposes its Instance subscriptions
  const downloadsView = own(vscode.window.createTreeView('modbench.downloads', {
    treeDataProvider: downloadsProvider,
    canSelectMany: true,
  }));
  // Dims hidden rows once Show hidden is on — the sole cue distinguishing them, since Show
  // hidden is additive, not an exclusive filter.
  own(vscode.window.registerFileDecorationProvider(
    new HiddenDownloadDecorationProvider(instance.value.paths.downloadsDir, () => downloadsProvider.hiddenNames()),
  ));
  own(registerNameFilter({
    view: downloadsView, object: 'modbench.downloadedFile', placeholder: 'Filter downloads…',
    setFilter: (text) => downloadsProvider.setFilter(text),
    hasRows: async () => (await downloadsProvider.getChildren()).length > 0,
    onRowsChanged: downloadsProvider.onDidChangeTreeData,
  }));
  own(registerDownloadsSortCommand(downloadsProvider));
  for (const disposable of [
    ...registerDownloadsHiddenToggleCommands(downloadsProvider),
    ...registerDownloadsSingleRowCommands(instanceRoot, instance, reporter, install),
    ...registerDownloadsMultiRowCommands(instanceRoot, reporter, ask),
  ]) own(disposable);
  return downloadsProvider;
}

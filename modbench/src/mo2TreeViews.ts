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
import type { Instance, InstanceView } from './instance/instance';
import type { Own } from './session';
import type { Reporter } from './ports/reporter';
import type { AskQuestion } from './ports/dialog';
import { registerNameFilter } from './nameFilter';
import { setMo2InstanceContext } from './workspaceConfig';

/** Always empty, so VS Code renders the `viewsWelcome` contribution instead of the tree.
 *  `getTreeItem` is unreachable: `getChildren` never yields an element. */
export const NOT_MO2_INSTANCE_PROVIDER: vscode.TreeDataProvider<never> = {
  getTreeItem: () => { throw new Error('unreachable — NOT_MO2_INSTANCE_PROVIDER never yields children'); },
  getChildren: () => [],
};

/** A real provider would only fail lazily on first read, so the view gets an always-empty stub
 *  and its `viewsWelcome` contribution renders an actionable message instead. */
export function registerNotMo2InstanceWelcome(
  instanceRoot: string,
  outputChannel: vscode.LogOutputChannel,
): vscode.Disposable {
  outputChannel.info(`[toolbox] Workspace "${instanceRoot}" is not an MO2 instance — showing welcome content instead of the Mods tree.`);
  setMo2InstanceContext(false);
  return vscode.window.createTreeView('modbench.modList', { treeDataProvider: NOT_MO2_INSTANCE_PROVIDER });
}
/** Tree, filter and profile readout together, because the view's description has exactly one
 *  owner. Split apart, a profile update and a filter keystroke race for that property and the
 *  loser silently vanishes. */
export function createModListView(
  own: Own,
  modListProvider: ModListProvider,
  instance: Pick<Instance, 'value' | 'subscribe'>,
): { modListView: vscode.TreeView<ModlistNode>; updateProfileDescription: () => Promise<void> } {
  const modListView = own(vscode.window.createTreeView('modbench.modList', {
    treeDataProvider: modListProvider,
    showCollapseAll: true,
    dragAndDropController: modListProvider,
  }));
  const modListFilter = own(registerNameFilter({
    view: modListView,
    viewId: 'modbench.modList',
    placeholder: 'Filter mods…',
    setFilter: (text, grouping) => modListProvider.setFilter(text, grouping),
    // The pinned Overwrite row sits outside all filtering (it is a fixture over the folder, not
    // a modlist entry), so it is not evidence that the term matched anything.
    hasRows: async () => (await modListProvider.getChildren()).some((n) => !(n instanceof OverwriteNode)),
    toggle: { icon: 'list-tree', label: 'Group by separator' },
  }));
  // Async only because Refresh's own sequence awaits it (ADR-0014); the profile is a field of
  // the value the Instance already landed, so there is no disk read left to fail.
  const updateProfileDescription = () => {
    modListFilter.setBaseDescription(instance.value.activeProfile);
    return Promise.resolve();
  };
  void updateProfileDescription();
  // A profile switch rewrites ModOrganizer.ini, which the Instance watches — the recompute it
  // lands is what moves this readout, not the gesture.
  own(instance.subscribe(() => void updateProfileDescription()));
  return { modListView, updateProfileDescription };
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
  const downloadsProvider = own(new DownloadsProvider({ // disposes its Instance subscriptions
    instance, reporter,
  }));
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
    view: downloadsView, viewId: 'modbench.downloads', placeholder: 'Filter downloads…',
    setFilter: (text) => downloadsProvider.setFilter(text),
    hasRows: async () => (await downloadsProvider.getChildren()).length > 0,
  }));
  own(registerDownloadsSortCommand(downloadsProvider));
  for (const disposable of [
    ...registerDownloadsHiddenToggleCommands(downloadsProvider),
    ...registerDownloadsSingleRowCommands(instanceRoot, instance, reporter, install),
    ...registerDownloadsMultiRowCommands(instanceRoot, reporter, ask),
  ]) own(disposable);
  return downloadsProvider;
}

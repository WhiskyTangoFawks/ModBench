import * as vscode from 'vscode';
import type { RecordFilter } from '../client';
import type { InstanceView } from '../instanceLoader/instance';
import { originFiles } from '../instanceLoader/loadOrderSnapshot';
import { messageLine, registerNameFilter, type NameFilter, type SyncMessage } from '../drivingLib/nameFilter';
import { reorderOver, type PluginsAccess } from '../pluginsCommands/plugins';
import type { Reporter } from '../ports/reporter';
import { PluginsTreeProvider, type PluginFactsClient, type PluginsTreeNode } from './PluginsTreeProvider';
import type { PluginTreeProvider } from './PluginTreeProvider';
import { publishPluginWarnings } from './loadDiagnostics';
import { pluginsKeyContext } from './gestureEntry';
import { ImplicitMasterDecorationProvider } from './ImplicitMasterDecorationProvider';
import { onPluginCheckboxChanged } from './pluginCheckboxHandler';
import { registerPluginSortCommands, registerRevealInExplorerCommand } from './pluginListCommands';
import { registerPluginEnableCommands } from './pluginParticipationCommands';
import { FilterCodeLensProvider } from './FilterCodeLensProvider';
import { makeShowRecordFilter } from './recordFilterCommands';
import { subscribeTreeToNotifications } from './treeNotifications';

export interface PluginsViewDeps {
  /** The tree's only row input: name, origin, slot, enabled and winning for every plugin. */
  instance: InstanceView;
  access: PluginsAccess;
  /** The record browser that supplies a plugin row's children. */
  recordBrowser: PluginTreeProvider;
  /** Every plugin-keyed fact the tree's badges read, and the pushes that re-read them. */
  client: PluginFactsClient;
  /** Plugin sync's failure, for the view's message line. */
  pluginSync: SyncMessage;
  /** The path of a file at the root of the Data folder, answered by a box this view does not
   *  reference. */
  dataFolderFile: (name: string) => string | undefined;
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
  reporterFor: (tag: string) => Reporter;
}

export interface PluginsView extends vscode.Disposable {
  tree: PluginsTreeProvider;
  view: vscode.TreeView<PluginsTreeNode>;
  nameFilter: NameFilter;
  showRecordFilter: (filter: RecordFilter | null) => void;
}

// The one Plugins tree (ADR-0017; target-architecture.d2, Plugins).
export function createPluginsView(deps: PluginsViewDeps): PluginsView {
  const { instance, access, recordBrowser, client, pluginSync, log, reporterFor } = deps;
  const filesOf = (origin: string) => originFiles(instance.value.plugins, origin);
  const loadDiagnostics = vscode.languages.createDiagnosticCollection('modbench-diagnosis');
  const changedOutsideDiagnostics = vscode.languages.createDiagnosticCollection('modbench-changed-outside');
  const tree = new PluginsTreeProvider({
    instance, log, reporter: reporterFor('pluginList'),
    source: { reorderPlugins: reorderOver(access, () => instance.value.activeProfile) },
    dataFolderFile: deps.dataFolderFile,
    records: recordBrowser,
    client,
    publishDiagnoses: (reports) => publishPluginWarnings(loadDiagnostics, filesOf, reports),
    publishChangedOutside: (warnings) => publishPluginWarnings(changedOutsideDiagnostics, filesOf, warnings),
  });
  const view = vscode.window.createTreeView('modbench.pluginListTree', {
    treeDataProvider: tree,
    canSelectMany: true,
    // A drag moves plugins.txt lines, which the same provider owns.
    dragAndDropController: tree,
    // commands.md, Chrome: Collapse All is on trees only, and this
    // one is hierarchical — plugin → record type → record.
    showCollapseAll: true,
  });
  const showKeyContext = () => {
    for (const [name, value] of Object.entries(pluginsKeyContext(view.selection, (row) => tree.isEnabled(row)))) {
      void vscode.commands.executeCommand('setContext', `modbench.plugin.${name}`, value);
    }
    void vscode.commands.executeCommand('setContext', 'modbench.plugin.anyCompilable', tree.anyCompilable());
  };
  showKeyContext();
  const keyContextSubscriptions = [view.onDidChangeSelection(showKeyContext), tree.onDidChangeTreeData(showKeyContext)];
  const nameFilter = registerPluginsNameFilter(view, tree, pluginSync);
  const lens = new FilterCodeLensProvider();
  const unsubscribe = subscribeTreeToNotifications(client, recordBrowser, () => { void tree.refreshFacts(); });
  // Disposed in order: what reads the tree and the view goes before them.
  const disposable = vscode.Disposable.from(
    { dispose: unsubscribe },
    vscode.languages.registerCodeLensProvider({ language: 'sql' }, lens),
    ...registerPluginEnableCommands(
      access, instance, () => view.selection, reporterFor('pluginListTree.enableDisable'), tree),
    ...registerPluginSortCommands(tree),
    registerRevealInExplorerCommand(tree, reporterFor('pluginListTree.revealInExplorer'), () => view.selection),
    view.onDidChangeCheckboxState((e) => onPluginCheckboxChanged(
      e, access, () => instance.value.activeProfile, reporterFor('pluginListTree.checkbox'), tree)),
    // Grays an implicit master's row the way the reference tool grays COL_NAME for a forceLoaded
    // plugin — live against the tree's own locked row URIs so it never drifts from what is rendered.
    vscode.window.registerFileDecorationProvider(new ImplicitMasterDecorationProvider(() => tree.lockedRowUris())),
    nameFilter,
    ...keyContextSubscriptions,
    view, tree, changedOutsideDiagnostics, loadDiagnostics,
  );
  return {
    tree, view, nameFilter,
    showRecordFilter: makeShowRecordFilter(lens, { pluginsNameFilter: nameFilter, pluginsTree: tree }),
    dispose: () => { disposable.dispose(); },
  };
}

// The axis that narrows *which plugin rows* appear, composing with (never replacing) the record
// filter's axis over which records appear under an expanded row.
export function registerPluginsNameFilter(
  view: { description?: string; message?: string }, provider: PluginsTreeProvider,
  pluginSync: SyncMessage,
): NameFilter {
  return registerNameFilter({
    view, object: 'modbench.plugin', placeholder: 'Filter plugins…',
    setFilter: (text) => provider.setFilter(text),
    hasRows: async () => (await provider.getChildren()).length > 0,
    viewMessage: () => messageLine(provider.viewMessage(), pluginSync.message()),
    standingMessage: () => provider.lastGoodReadMessage(),
    onRowsChanged: provider.onDidChangeTreeData,
    onViewMessageChanged: (listener) => pluginSync.onMessageChanged(listener),
  });
}

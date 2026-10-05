import * as vscode from 'vscode';
import type { MEditClient, RecordFilter } from '../client';
import { originFiles } from '../instanceLoader/loadOrderSnapshot';
import { joinSyncMessages, messageLine, registerNameFilter, type NameFilter, type SyncMessage } from '../drivingLib/nameFilter';
import { reorderOver, type PluginSyncRun, type PluginsAccess } from '../pluginsCommands/plugins';
import type { Reporter } from '../ports/reporter';
import { reportSyncFailures, type SyncChannel, type SyncFailureReport } from '../drivingLib/syncFailureReport';
import { createPluginSync, type PluginSync } from './pluginSync';
import { PluginsTreeProvider, type PluginFactsClient, type PluginsInstance, type PluginsTreeNode } from './PluginsTreeProvider';
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
import { followIndexStatus } from './indexStatus';
import type { PluginsViewProgress } from './pluginRowCommands';
import type { ReconcileNarrator } from './reconcileNarrator';
import type { StatusBar } from './statusBar';

export interface PluginsViewDeps {
  /** The tree's only row input: name, origin, slot, enabled and winning for every plugin. */
  instance: PluginsInstance;
  access: PluginsAccess;
  /** The record browser that supplies a plugin row's children. */
  recordBrowser: PluginTreeProvider;
  /** Every plugin-keyed fact the tree's badges read, the pushes that re-read them, and the index
   *  status. */
  client: PluginFactsClient & Pick<MEditClient, 'getActiveFilter' | 'onReconnected'>;
  statusBar: StatusBar;
  /** A reconcile reached Ready: what the views outside this box refetch. */
  notifyConflictsComputed: () => void;
  /** Plugin sync, whose failure the view's message line says and whose Output lines go to
   *  `channel`. */
  syncPlugins: PluginSyncRun;
  channel: SyncChannel;
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
  pluginSync: PluginSync;
  /** The load order Editing could not put: its refusal is this view's message line too. */
  loadOrderPut: SyncFailureReport;
  showRecordFilter: (filter: RecordFilter | null) => void;
  progress: PluginsViewProgress;
  narrator: ReconcileNarrator;
}

// The one Plugins tree (ADR-0017; target-architecture.d2, Plugins).
export function createPluginsView(deps: PluginsViewDeps): PluginsView {
  const { instance, access, recordBrowser, client, syncPlugins, channel, statusBar, notifyConflictsComputed, log, reporterFor } = deps;
  const pluginSync = createPluginSync(syncPlugins, channel);
  const loadOrderPut = reportSyncFailures('put load order', 'The load order is not sent', (line) => channel.error(`[loadOrder] ${line}`));
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
  const nameFilter = registerPluginsNameFilter(view, tree, joinSyncMessages(pluginSync, loadOrderPut));
  const lens = new FilterCodeLensProvider();
  const showRecordFilter = makeShowRecordFilter(lens, { pluginsNameFilter: nameFilter, pluginsTree: tree });
  const progress = pluginsViewProgress(view, nameFilter);
  const indexStatus = followIndexStatus({
    client, tree, recordBrowser, progress, statusBar, showRecordFilter, notifyConflictsComputed, log,
    reporter: reporterFor('loadOrder'),
  });
  const unsubscribe = subscribeTreeToNotifications(client, recordBrowser, () => { void tree.refreshFacts(); });
  // Disposed in order: what reads the tree and the view goes before them.
  const disposable = vscode.Disposable.from(
    indexStatus,
    { dispose: unsubscribe },
    vscode.languages.registerCodeLensProvider({ language: 'sql' }, lens),
    ...registerPluginEnableCommands(
      access, instance, () => view.selection, reporterFor('pluginListTree.enableDisable')),
    ...registerPluginSortCommands(tree),
    registerRevealInExplorerCommand(tree, reporterFor('pluginListTree.revealInExplorer'), () => view.selection),
    view.onDidChangeCheckboxState((e) => onPluginCheckboxChanged(
      e, access, () => instance.value.activeProfile, reporterFor('pluginListTree.checkbox'), instance)),
    // Grays an implicit master's row the way the reference tool grays COL_NAME for a forceLoaded
    // plugin — live against the tree's own locked row URIs so it never drifts from what is rendered.
    vscode.window.registerFileDecorationProvider(new ImplicitMasterDecorationProvider(() => tree.lockedRowUris())),
    nameFilter,
    ...keyContextSubscriptions,
    view, tree, changedOutsideDiagnostics, loadDiagnostics,
  );
  return {
    tree, view, nameFilter, pluginSync, loadOrderPut, showRecordFilter, progress, narrator: indexStatus.narrator,
    dispose: () => { disposable.dispose(); },
  };
}

export function pluginsViewProgress(
  view: { message?: string | vscode.MarkdownString }, nameFilter: Pick<NameFilter, 'refresh'>,
): PluginsViewProgress {
  const say = (message: string | undefined) => {
    view.message = message;
    if (message === undefined) nameFilter.refresh();
  };
  return {
    say,
    while: (work) => Promise.resolve(vscode.window.withProgress(
      { location: { viewId: 'modbench.pluginListTree' } },
      async () => { try { await work(); } finally { say(undefined); } },
    )),
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

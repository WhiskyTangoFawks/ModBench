import * as vscode from 'vscode';
import type { MEditClient, PluginAddress } from '../client';
import { saveDirtyPluginSource } from '../sourceLanguage/dirtyPluginSource';
import { joinSyncMessages, messageLine, registerNameFilter, type NameFilter, type SyncMessage } from '../drivingLib/nameFilter';
import type { InstanceAdapter } from '../instanceAdapter/instanceAdapter';
import type { Reporter } from '../ports/reporter';
import type { AskQuestion } from '../ports/dialog';
import type { CopyValueAdapter } from '../drivingLib/copyValue';
import type { RecordWrite } from '../drivingLib/writingGesture';
import type { SourceEditing } from '../drivingLib/sourceEditing';
import { originFiles } from '../instanceLoader/loadOrderSnapshot';
import type { Instance, InstanceValue } from '../instanceLoader/instance';
import { reportSyncFailures, type SyncChannel, type SyncFailureReport } from '../drivingLib/syncFailureReport';
import type { PluginSync } from './pluginSync';
import { PluginsTreeProvider, type PluginsInstance, type PluginsTreeNode } from './PluginsTreeProvider';
import type { PluginFactsClient } from './pluginFactsFeed';
import type { RecordBrowser } from './RecordBrowser';
import { publishPluginWarnings } from './loadDiagnostics';
import { pluginsKeyContext } from './gestureEntry';
import { RecordDecorationProvider } from './RecordDecorationProvider';
import { ImplicitMasterDecorationProvider } from './ImplicitMasterDecorationProvider';
import { onPluginCheckboxChanged } from './pluginCheckboxHandler';
import {
  pluginsCopyValueText, registerCreatePluginCommand, registerPluginSortCommands, registerRevealInExplorerCommand,
} from './pluginListCommands';
import { registerRenamePluginCommand, type RenamePluginDeps } from './pluginRenameCommand';
import { registerRecordCreateCommand } from './createRecordCommand';
import { createdRecordSelection } from './createdRecordSelection';
import {
  CompileProblems, registerCompileCommand, registerDecompileCommand, registerTrackCommand, type CompileDeps, type DecompileDeps,
  type TrackDeps,
} from './pluginRowCommands';
import { registerPluginMoveCommand } from './pluginMoveCommand';
import { registerPluginEnableCommands } from './pluginParticipationCommands';
import { FilterCodeLensProvider } from './FilterCodeLensProvider';
import { makeShowRecordFilter, registerFilterCommands } from './recordFilterCommands';
import { survivingSelection } from './survivingSelection';
import { subscribeTreeToNotifications } from './treeNotifications';
import { followIndexStatus } from './indexStatus';
import type { PluginsViewProgress } from './pluginRowCommands';
import type { RecordCreateDeps } from './createRecordCommand';
import type { ReconcileNarrator } from './reconcileNarrator';
import type { StatusBar } from './statusBar';

export interface PluginsViewDeps {
  /** The tree's only row input: name, origin, line, enabled and winning for every plugin. */
  instance: PluginsInstance & Pick<Instance, 'quiet'>;
  adapter: InstanceAdapter;
  /** The record browser that supplies a plugin row's children. */
  recordBrowser: RecordBrowser;
  /** Every plugin-keyed fact the tree's badges read, the pushes that re-read them, and the index
   *  status. */
  client: PluginFactsClient & RenamePluginDeps['client'] & TrackDeps['client'] & DecompileDeps['client'] & CompileDeps['client']
    & RecordCreateDeps['client'] & Pick<MEditClient, 'getActiveFilter' | 'onLoadOrderStatus' | 'onReconnected' | 'onStatusChanged' | 'setFilter' | 'clearFilter' | 'createPlugin'>;
  statusBar: StatusBar;
  /** Registers the tracked mods' repositories: a reconcile reached Ready, or a track landed. */
  registerRepositories: () => Promise<void>;
  ask: AskQuestion;
  recordWrite: RecordWrite;
  sourceEditing: SourceEditing;
  /** The rows of the focused Mods or Plugins view, which the palette's track acts on. */
  trackSelection: () => readonly unknown[];
  /** The Mods view's id, whose bar a track from a Mods row runs under. */
  modsView: string;
  /** Plugin sync, whose failure the view's message line says. */
  pluginSync: PluginSync;
  channel: SyncChannel;
  /** The path of a file at the root of the Data folder, answered by a box this view does not
   *  reference. */
  dataFolderFile: (name: string) => string | undefined;
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
  reporterFor: (tag: string) => Reporter;
}

export interface PluginsView extends vscode.Disposable {
  view: vscode.TreeView<PluginsTreeNode>;
  /** The view the focused view follows: its selection holds the rows a rebuilt tree still shows. */
  followed: Pick<vscode.TreeView<PluginsTreeNode>, 'selection' | 'onDidChangeSelection'>;
  nameFilter: NameFilter;
  /** The load order Editing could not put: its refusal is this view's message line too. */
  loadOrderPut: SyncFailureReport;
  copyValue: CopyValueAdapter;
  progress: PluginsViewProgress;
  narrator: ReconcileNarrator;
}

// The one Plugins tree (ADR-0017; target-architecture.d2, Plugins).
export function createPluginsView(deps: PluginsViewDeps): PluginsView {
  const { instance, adapter, recordBrowser, client, pluginSync, channel, statusBar, registerRepositories, log, reporterFor } = deps;
  const registerInBackground = () => { void registerRepositories(); };
  const loadOrderPut = reportSyncFailures('put load order', 'The load order is not sent', (line) => channel.error(`[loadOrder] ${line}`));
  const pluginFile = (plugin: PluginAddress) => tree.pluginFile(plugin);
  const loadDiagnostics = vscode.languages.createDiagnosticCollection('modbench-diagnosis');
  const changedOutsideDiagnostics = vscode.languages.createDiagnosticCollection('modbench-changed-outside');
  const tree = new PluginsTreeProvider({
    instance, log,
    dataFolderFile: deps.dataFolderFile,
    records: recordBrowser,
    client,
    publishDiagnoses: (reports) => publishPluginWarnings(loadDiagnostics, pluginFile, reports),
    publishChangedOutside: (warnings) => publishPluginWarnings(changedOutsideDiagnostics, pluginFile, warnings),
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
  const selected = survivingSelection(view, (row) => tree.shownRow(row));
  const showKeyContext = () => {
    for (const [name, value] of Object.entries(pluginsKeyContext(selected.rows(), (row) => tree.isEnabled(row)))) {
      void vscode.commands.executeCommand('setContext', `modbench.plugin.${name}`, value);
    }
    void vscode.commands.executeCommand('setContext', 'modbench.plugin.anyCompilable', tree.facts.rows.anyCompilable());
  };
  showKeyContext();
  const keyContextSubscriptions = [view.onDidChangeSelection(showKeyContext), tree.onDidChangeTreeData(showKeyContext)];
  const nameFilter = registerPluginsNameFilter(view, tree, joinSyncMessages(pluginSync, loadOrderPut, recordBrowser.beneathFailure));
  const lens = new FilterCodeLensProvider();
  const showRecordFilter = makeShowRecordFilter(lens, { pluginsNameFilter: nameFilter, pluginsTree: tree });
  const progress = pluginsViewProgress(view, nameFilter);
  const indexStatus = followIndexStatus({
    client, facts: tree.facts, recordBrowser, progress, statusBar, showRecordFilter, registerRepositories: registerInBackground, log,
    reporter: reporterFor('loadOrder'),
  });
  const compileDiagnostics = vscode.languages.createDiagnosticCollection('modbench-compile');
  const compileProblems = new CompileProblems(compileDiagnostics);
  const unsubscribe = subscribeTreeToNotifications(client, recordBrowser, () => { void tree.facts.refresh(); });
  // Disposed in order: what reads the tree and the view goes before them.
  const recordDecorations = new RecordDecorationProvider(recordBrowser, () => tree.lockedRowUris());
  const disposable = vscode.Disposable.from(
    indexStatus,
    recordDecorations,
    view.onDidExpandElement(({ element }) => { if (element.resourceUri) recordBrowser.expandedRow(element.resourceUri); }),
    view.onDidCollapseElement(({ element }) => { if (element.resourceUri) recordBrowser.collapsedRow(element.resourceUri); }),
    vscode.window.registerFileDecorationProvider(recordDecorations),
    { dispose: unsubscribe },
    vscode.languages.registerCodeLensProvider({ language: 'sql' }, lens),
    ...registerPluginEnableCommands(
      adapter, instance, selected.rows, reporterFor('pluginListTree.enableDisable')),
    ...registerPluginGestures(deps, { tree, view, progress, selection: selected.rows, compileProblems }),
    registerPluginMoveCommand(adapter, client, instance, { selection: selected.rows, movePlaces: (names) => tree.movePlaces(names) },
      reporterFor('pluginListTree.move')),
    ...registerFilterCommands({
      client, treeProvider: recordBrowser, refreshMatchingPlugins: () => { void tree.facts.refresh(); },
      showRecordFilter, reporter: reporterFor('recordFilter'),
    }),
    ...registerPluginSortCommands(tree),
    registerRevealInExplorerCommand(tree, reporterFor('pluginListTree.revealInExplorer'), selected.rows),
    view.onDidChangeCheckboxState((e) => onPluginCheckboxChanged(
      e, adapter, () => instance.value.activeProfile, reporterFor('pluginListTree.checkbox'), instance)),
    // Grays an implicit master's row the way the reference tool grays COL_NAME for a forceLoaded
    // plugin — live against the tree's own locked row URIs so it never drifts from what is rendered.
    vscode.window.registerFileDecorationProvider(new ImplicitMasterDecorationProvider(() => tree.lockedRowUris())),
    nameFilter,
    ...keyContextSubscriptions,
    selected, view, tree, changedOutsideDiagnostics, loadDiagnostics, compileDiagnostics,
  );
  return {
    view, nameFilter,
    followed: { get selection() { return selected.rows(); }, onDidChangeSelection: view.onDidChangeSelection }, loadOrderPut,
    copyValue: { text: pluginsCopyValueText(selected.rows), reporterTag: 'pluginListTree.copyValue' },
    progress, narrator: indexStatus.narrator,
    dispose: () => { disposable.dispose(); },
  };
}

function registerPluginGestures(
  { instance, adapter, client, ask, registerRepositories, pluginSync, reporterFor, recordWrite, sourceEditing, trackSelection, modsView }: PluginsViewDeps,
  { tree, view, progress, selection, compileProblems }: {
    tree: PluginsTreeProvider; view: vscode.TreeView<PluginsTreeNode>; progress: PluginsViewProgress;
    selection: () => readonly PluginsTreeNode[]; compileProblems: CompileProblems;
  },
): vscode.Disposable[] {
  return [
    registerTrackCommand({
      progress, instance, client, reporter: reporterFor('mod.track'), onTracked: registerRepositories,
      modDirs: () => instance.value.paths.modDirs, modsView,
    }, trackSelection),
    registerDecompileCommand({ client, instance, reporter: reporterFor('plugin.decompile'), ask }, selection),
    registerCompileCommand({
      client, instance, reporter: reporterFor('plugin.compile'), problems: compileProblems,
      originFiles: (origin) => originFiles(instance.value, origin), saveUnsaved: saveDirtyPluginSource,
    }, selection),
    registerRecordCreateCommand({
      client, reporter: reporterFor('record.create'), write: recordWrite, source: sourceEditing,
      createdRecords: createdRecordSelection({ client, rowOf: (place, formKey) => tree.recordRow(place, formKey), view }),
    }, selection),
    registerRenamePluginCommand({ client, adapter, ask, instance, reporter: reporterFor('plugin.rename'), source: sourceEditing }, selection),
    registerCreatePluginCommand(client, instance, reporterFor('newPlugin')),
    vscode.commands.registerCommand('modbench.plugin.sync', (value: InstanceValue) => pluginSync.run(value.pluginSyncArguments)),
  ];
}

function pluginsViewProgress(
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
function registerPluginsNameFilter(
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

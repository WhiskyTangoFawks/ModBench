// The composition root (target-architecture.d2, Activation): builds every box and registers it
// with VS Code, and decides nothing: eslint.config.mjs holds that.

import * as vscode from 'vscode';
import { createMEditClient, createLoadOrderSender, type LoadOrderSender, type MEditClient } from './client';
import { PluginTreeProvider } from './plugins/PluginTreeProvider';
import { makeReporter } from './reporter';
import { askQuestion } from './dialog';
import { moveToTrash } from './trash';
import { selectionInFocusedView, nexusRowInFocusedView } from './drivingLib/inFocusedView';
import { createFocusedView, type FocusedView } from './drivingLib/focusedView';
import { createEditor, type Editor } from './editor';
import { createSourceLanguage } from './sourceLanguage';
import { registerFilterCommands as registerNameFilterCommands } from './drivingLib/nameFilter';
import { registerCopyValueCommand } from './drivingLib/copyValue';
import { reportFailure } from './drivingLib/reportFailure';
import { Instance, type InstanceValue } from './instanceLoader/instance';
import { originFiles, type OriginFilesOf } from './instanceLoader/loadOrderSnapshot';
import { dataFolderFile } from './tables/gamePaths';
import { GAME_FOLDER_SETTING } from './instanceAdapter/instanceAdapter';
import { isMo2Instance, mo2InstanceAdapter } from './instanceAdapter/mo2Instance';
import { createStatusBar, type StatusBar } from './plugins/statusBar';
import { meditConfig, gameDirectoryOverrides } from './workspaceConfig';
import {
  registerTrackCommand, registerDecompileCommand, registerCompileCommand, CompileProblems, type CompileDeps, type TrackDeps,
  type PluginsViewProgress,
} from './plugins/pluginRowCommands';
import { registerFilterCommands } from './plugins/recordFilterCommands';
import { noticeExternalChanges } from './plugins/externalChangeNotice';
import { trackedRepositoriesOver } from './plugins/trackedRepositories';
import { registerRecordCreateCommand } from './plugins/createRecordCommand';
import { createdRecordSelection } from './plugins/createdRecordSelection';
import { recordWriteOver } from './plugins/recordWrite';
import { createPluginsView, type PluginsView, type PluginsViewDeps } from './plugins/pluginsView';
import { editingView } from './plugins/editingView';
import { pluginsCopyValueText, registerCreatePluginCommand } from './plugins/pluginListCommands';
import { registerRenamePluginCommand } from './plugins/pluginRenameCommand';
import type { PluginsTreeNode, PluginsTreeProvider } from './plugins/PluginsTreeProvider';
import type { RecordWrite } from './drivingLib/writingGesture';
import { MODS_KEY_ARGS } from './mods/gestureEntry';
import type { ModlistNode } from './mods/ModListProvider';
import { registerModDecorations } from './mods/modDecorations';
import { showModRepositories } from './mods/modRepositories';
import { createModsView } from './mods/modsView';
import { registerModInstallCommands } from './mods/installCommands';
import { registerCompareFileCommand } from './mods/compareFile';
import { registerGoToModCommand } from './mods/goToMod';
import { registerConflictTable } from './mods/conflictTableEditor';
import {
  registerFileExclusionCommands, registerModContextCommands, registerModEnableCommands, registerModMoveCommand,
  registerSeparatorCommands, registerCreateEmptyModCommand, registerOpenFolderCommand, registerViewOnNexusCommand, modsCopyValueText,
} from './mods/modManagementCommands';
import type { DownloadsTreeNode } from './downloads/DownloadsProvider';
import { downloadsCopyValueText } from './downloads/keyContext';
import { createDownloadsView } from './downloads/downloadsView';
import { ToolboxProvider } from './toolbox/ToolboxProvider';
import { registerRefreshCommand, registerToolboxCommands } from './toolbox/toolboxCommands';
import { openedFolder, whenOpened, markFirstReadLanded } from './toolbox/instanceCheck';
import { refreshOnGameDirectoryChange } from './toolbox/gameDirectorySetting';
import { launchBackend } from './toolbox/autoLaunch';
import { pluginSyncOver } from './pluginsCommands/plugins';
import { modSyncOver } from './modlist/modlist';
import { installNameRefusal } from './install/install';
import { warnIfFomod } from './install/fomodWarning';
import { refresh } from './instanceCommands/loadOrder';
import { editingFlow, exitEditing } from './instanceCommands/editing';
import { loadOrderPutOnEachValue, modSyncOnEachValue, pluginSyncOnEachValue } from './syncWiring';
import type { Reporter } from './ports/reporter';
import type { AskQuestion } from './ports/dialog';
import type { MoveToTrash } from './ports/trash';

interface ExtensionSession {
  loadOrderSender?: LoadOrderSender;
}

// Records a disposable against its owner's teardown and hands it back. `src/test/toolboxScan.test.ts`
// fails on a registration that skips it.
type Own = <T extends vscode.Disposable>(disposable: T) => T;

type ViewsClient = Pick<MEditClient,
  'putLoadOrder' | 'rebuildIndex' | 'createPlugin' | 'renameSource' | 'getPluginDependants' | 'getLightPluginsSupported'
  | 'status' | 'start' | 'stop' | 'onStatusChanged' | 'onReconnected'>;

interface ViewsDeps {
  outputChannel: vscode.LogOutputChannel;
  session: ExtensionSession;
  client: ViewsClient;
  recordBrowser: PluginTreeProvider;
  pluginFacts: PluginsViewDeps['client'];
  statusBar: StatusBar;
  notifyConflictsComputed: () => void;
  reporterFor: (tag: string) => Reporter;
  ask: AskQuestion;
  trash: MoveToTrash;
  extensionId: string;
  extensionUri: vscode.Uri;
  focusedView: FocusedView;
  editor: Pick<Editor, 'nameFilters' | 'copyValue'>;
}

interface PluginsHandle {
  selection: () => readonly PluginsTreeNode[];
  progress: PluginsViewProgress;
  recordRow: PluginsTreeProvider['recordRow'];
  reveal: PluginsView['view']['reveal'];
  refreshFacts: PluginsTreeProvider['refreshFacts'];
  showRecordFilter: PluginsView['showRecordFilter'];
}

interface InstanceFacts {
  trackedMods: () => ReadonlySet<string>;
  modDirs: () => ReadonlyMap<string, string>;
  refresh: () => Promise<void>;
}

interface InstanceSide {
  /** Absent together, on the path with no instance to read. */
  instance?: Instance;
  enterEditing?: () => Promise<void>;
  toolboxProvider: ToolboxProvider;
  facts: InstanceFacts;
  plugins: PluginsHandle;
  latestSent: LoadOrderSender['latest'];
  originFiles: OriginFilesOf;
  modListSelection: () => readonly ModlistNode[];
  pluginsSelection: () => readonly PluginsTreeNode[];
  downloadsSelection: () => readonly DownloadsTreeNode[];
  trackSelection: () => readonly unknown[];
}

type Views = InstanceSide & vscode.Disposable;

const ownAll = (own: Own, disposables: vscode.Disposable[]): void => {
  disposables.forEach((disposable) => own(disposable));
};

function buildBareSide(own: Own): InstanceSide {
  return {
    toolboxProvider: own(new ToolboxProvider({ instance: undefined })),
    facts: { trackedMods: () => new Set(), modDirs: () => new Map(), refresh: () => Promise.resolve() },
    plugins: {
      selection: () => [], progress: { while: (work) => work(), say: () => undefined },
      recordRow: () => Promise.resolve(undefined), reveal: () => Promise.resolve(), refreshFacts: () => Promise.resolve(),
      showRecordFilter: () => undefined,
    },
    latestSent: () => Promise.resolve(undefined),
    originFiles: () => undefined,
    modListSelection: () => [], pluginsSelection: () => [], downloadsSelection: () => [],
    trackSelection: () => [],
  };
}

function buildInstanceSide(own: Own, instanceRoot: string, deps: ViewsDeps): InstanceSide {
  const {
    outputChannel, session, client, recordBrowser, pluginFacts,
    statusBar, notifyConflictsComputed, reporterFor, ask, trash, extensionId,
  } = deps;
  const log = (msg: string) => outputChannel.info(msg);
  const adapter = mo2InstanceAdapter({ instanceRoot, gameDirectoryOverrides });
  const access = { instanceRoot, adapter };
  const instance = own(new Instance({
    adapter, window: vscode.window, log, logReadFailure: (line) => outputChannel.error(line),
  }));
  own(markFirstReadLanded(instance));
  own(refreshOnGameDirectoryChange(GAME_FOLDER_SETTING, vscode.workspace.onDidChangeConfiguration, () => instance.refresh()));
  // Fire-and-forget: watchers alone leave the value at its EMPTY sentinel until a change, so
  // this kicks off the first real read. The Plugins tree's own `sequence === 0` guard is
  // what keeps activation from being blocking here.
  void instance.refresh();
  ownAll(own, registerModDecorations(instance, vscode.workspace));
  const sender = own(createLoadOrderSender(client));
  session.loadOrderSender = sender;
  const refreshIndex = () => refresh(client, instanceRoot, instance.value);
  const plugins = own(createPluginsView({
    instance, access, recordBrowser, client: pluginFacts, syncPlugins: pluginSyncOver(access), channel: outputChannel, statusBar, notifyConflictsComputed, reporterFor,
    dataFolderFile: (name) => dataFolderFile(instance.value.gameFolder, name),
    log: (level, msg) => outputChannel[level](msg),
  }));
  const { tree: pluginsTree, view: pluginListView, selection: pluginsSelection, nameFilter: pluginsFilter } = plugins;
  const { provider: modListProvider, view: modListView, nameFilter: modListFilter, modSync } = own(createModsView({
    instance, log: (line) => outputChannel.warn(`[modList] ${line}`), syncMods: modSyncOver(access), channel: outputChannel,
  }));
  own(modSyncOnEachValue(instance, modSync));
  own(pluginSyncOnEachValue(instance, plugins.pluginSync));
  own(showModRepositories(instance));
  const runModAction = (logLabel: string, failMessage: string, action: () => Promise<void>) =>
    reportFailure(reporterFor(logLabel), failMessage, action);
  const promptModName = (
    defaultName: string, validateInput?: (value: string) => Thenable<string | undefined> | string | undefined,
  ) =>
    vscode.window.showInputBox({ prompt: 'Mod name', value: defaultName, validateInput });
  const fomodWarning = warnIfFomod(reporterFor('install'));
  const view = editingView({
    narrator: plugins.narrator, progress: plugins.progress, log: outputChannel, revealLog: () => outputChannel.show(true), loadOrderPut: plugins.loadOrderPut,
    reportPut: (message) => reporterFor('loadOrder').report('error', message),
    reportEntry: (message) => reporterFor('enterEditing').report('error', message),
  });
  const editing = own(editingFlow({
    client, sender, instanceRoot, exitEditing: () => exitEditing(session, client),
    around: view.around, tell: view.tell, log: (message) => outputChannel.error(message),
  }));
  own(loadOrderPutOnEachValue(instance, editing));
  own(vscode.commands.registerCommand('modbench.instance.putLoadOrder', (value: InstanceValue) => editing.put(value)));
  const toolboxProvider = own(new ToolboxProvider({ instance, channel: outputChannel }));
  ownAll(own, registerToolboxCommands({ access, instance, extensionId, reporterFor }));
  ownAll(own, registerModContextCommands({
    access, instance, viewSelection: () => modListView.selection, reporter: reporterFor('mod.uninstall'), ask, trash,
    log: (line) => outputChannel.warn(`[modList] ${line}`),
  }));
  ownAll(own, registerModEnableCommands(access, instance, () => modListView.selection, reporterFor('mod.enableDisable')));
  ownAll(own, registerFileExclusionCommands(access, instance, () => modListView.selection, reporterFor('mod.excludeFile')));
  own(registerModMoveCommand(
    access, instance,
    { selection: () => modListView.selection, direction: () => modListProvider.viewDirection() },
    reporterFor('mod.move')));
  ownAll(own, registerSeparatorCommands(access, instance, reporterFor('separator'), ask, trash, () => modListView.selection));
  own(registerCreateEmptyModCommand(access, instance, reporterFor('mod.createEmpty')));
  own(registerOpenFolderCommand(instance, reporterFor('mod.openFolder'), () => modListView.selection));
  own(registerGoToModCommand(instance, reporterFor('mod.goToMod'), {
    selection: () => modListView.selection,
    rowFor: (origin) => modListProvider.rowFor(origin),
    reveal: (row) => modListView.reveal(row, { select: true, focus: true }),
  }));
  own(registerCompareFileCommand(instance, reporterFor('mod.compareFile'), () => modListView.selection));
  ownAll(own, registerConflictTable(instance, deps.extensionUri, () => modListView.selection, reporterFor('mod.openConflicts'), vscode.workspace));
  own(vscode.commands.registerCommand('modbench.mod.sync', (value: InstanceValue) => modSync.run(value.modSyncArguments)));
  own(registerRenamePluginCommand({ client, adapter: access.adapter, ask, instance, reporter: reporterFor('plugin.rename') }, pluginsSelection));
  own(vscode.commands.registerCommand('modbench.plugin.sync', (value: InstanceValue) => plugins.pluginSync.run(value.pluginSyncArguments)));
  const { view: downloadsView, nameFilter: downloadsFilter, installDownloaded } = own(createDownloadsView({
    access, instance, reporter: reporterFor('downloadList'), ask, trash,
    install: {
      nameNewMod: (defaultName) => promptModName(defaultName, (name) => installNameRefusal(access, name)),
      warnIfFomod: fomodWarning,
      log: (line) => outputChannel.warn(`[downloads] ${line}`),
    },
    logUnresolved: (line) => outputChannel.warn(`[instance] ${line}`),
  }));
  ownAll(own, registerModInstallCommands({ access, instance, runModAction, promptModName, warnIfFomod: fomodWarning, installDownloaded }));
  own(registerViewOnNexusCommand(instance, reporterFor('mod.viewOnNexus'), nexusRowInFocusedView(
    own, deps.focusedView, ['modbench.modList', 'modbench.downloads'], 'modbench.mod.nexusRowIn')));
  own(deps.focusedView.follow('modbench.modList', modListView));
  own(deps.focusedView.follow('modbench.pluginListTree', pluginListView));
  own(deps.focusedView.follow('modbench.downloads', downloadsView));
  ownAll(own, registerNameFilterCommands(
    () => deps.focusedView.id(),
    new Map([
      ['modbench.modList', modListFilter], ['modbench.pluginListTree', pluginsFilter], ['modbench.downloads', downloadsFilter],
      ...deps.editor.nameFilters,
    ]),
    () => vscode.window.setStatusBarMessage('Focus a list to filter it.', 5000)));
  const trackSelection = selectionInFocusedView(
    own, deps.focusedView, ['modbench.modList', 'modbench.pluginListTree'], 'modbench.mod.trackRowsIn');
  own(registerRefreshCommand({
    refresh: refreshIndex, nextRefill: () => plugins.narrator.nextRefill(), instance, reporter: reporterFor('refresh'), instanceRoot,
  }));
  return {
    instance, toolboxProvider,
    enterEditing: () => editing.enter(instance.landed()),
    facts: { trackedMods: () => instance.value.trackedMods, modDirs: () => instance.value.paths.modDirs, refresh: () => instance.refresh() },
    plugins: {
      selection: pluginsSelection, progress: plugins.progress,
      recordRow: (group, formKey) => pluginsTree.recordRow(group, formKey),
      reveal: (row, options) => pluginListView.reveal(row, options),
      refreshFacts: () => pluginsTree.refreshFacts(),
      showRecordFilter: (filter) => plugins.showRecordFilter(filter),
    },
    latestSent: () => sender.latest(),
    originFiles: (origin) => originFiles(instance.value, origin),
    modListSelection: () => modListView.selection, pluginsSelection,
    downloadsSelection: () => downloadsView.selection, trackSelection,
  };
}

function buildViews(deps: ViewsDeps): Views {
  const { client, reporterFor } = deps;
  const owned: vscode.Disposable[] = [];
  const own: Own = (disposable) => {
    owned.push(disposable);
    return disposable;
  };

  const opened = openedFolder(isMo2Instance, (line) => deps.outputChannel.info(line));
  const side = whenOpened(opened, {
    instance: (instanceRoot) => buildInstanceSide(own, instanceRoot, deps),
    notAnInstance: () => buildBareSide(own),
  });

  const toolboxView = own(vscode.window.createTreeView('modbench.toolbox', { treeDataProvider: side.toolboxProvider }));
  const showMessage = () => { toolboxView.message = side.toolboxProvider.viewMessage(); };
  showMessage();
  own(side.toolboxProvider.onDidChangeTreeData(showMessage));
  own(registerCreatePluginCommand(client, side.instance, reporterFor('newPlugin')));
  own(registerCopyValueCommand(
    [
      { text: modsCopyValueText(side.modListSelection), reporterTag: 'mod.copyValue' },
      { text: pluginsCopyValueText(side.pluginsSelection), reporterTag: 'pluginListTree.copyValue' },
      { text: downloadsCopyValueText(side.downloadsSelection), reporterTag: 'downloadedFile.copyValue' },
      ...deps.editor.copyValue,
    ],
    reporterFor,
    () => deps.focusedView.id(),
    () => vscode.window.setStatusBarMessage('Focus a list or a record cell to copy its value.', 5000),
  ));

  return {
    ...side,
    dispose: () => {
      owned.reverse().forEach((disposable) => { disposable.dispose(); });
      owned.length = 0;
    },
  };
}

export function activate(context: vscode.ExtensionContext): void {
  const session: ExtensionSession = {};
  const attachPort = meditConfig().get<number>('attachToBackendPort');

  const outputChannel = vscode.window.createOutputChannel('Modbench', { log: true });
  context.subscriptions.push(outputChannel);
  const log = (msg: string) => outputChannel.info(msg);

  const compileDiagnostics = vscode.languages.createDiagnosticCollection('modbench-compile');
  context.subscriptions.push(compileDiagnostics);

  // ADR-0002.
  const meditClient = createMEditClient({ backend: { attachPort }, backendLog: outputChannel, log });
  activeClient = meditClient; // deactivate()'s only way to reach it
  const statusBar = createStatusBar(meditClient);
  context.subscriptions.push(statusBar);
  const treeProvider = new PluginTreeProvider(meditClient, log);
  const focusedView = createFocusedView();

  const trackedRepositories = trackedRepositoriesOver({
    client: meditClient,
    outputChannel,
    trackedMods: () => views.facts.trackedMods(),
    modDirs: () => views.facts.modDirs(),
  });
  const instance = { refresh: () => views.facts.refresh() };
  const recordWrite = recordWriteOver(instance, { latest: () => views.latestSent() });
  const editor = createEditor({
    context, meditClient, outputChannel,
    reporterFor: (tag) => makeReporter(outputChannel, tag),
    ask: askQuestion,
    focusedView,
    viewSelections: new Map([['modbench.pluginListTree', () => views.plugins.selection()]]),
    recordWrite,
    refreshSourceControlFor: trackedRepositories.refreshSourceControlFor,
  });
  const conflictsComputed = trackedRepositories.conflictsComputedOver(() => { editor.announceConflictsComputed(); });
  const notifyConflictsComputed = () => { void conflictsComputed(); };
  const views = buildViews({
    outputChannel, session, client: meditClient,
    reporterFor: (tag) => makeReporter(outputChannel, tag),
    ask: askQuestion,
    trash: moveToTrash,
    recordBrowser: treeProvider,
    pluginFacts: meditClient,
    statusBar,
    notifyConflictsComputed,
    extensionId: context.extension.id,
    extensionUri: context.extensionUri,
    focusedView,
    editor,
  });
  const pluginRowDeps: PluginRowCommandDeps = {
    client: meditClient, outputChannel, compileProblems: new CompileProblems(compileDiagnostics),
    conflictsComputed, instance, recordWrite, plugins: views.plugins,
    originFiles: (origin) => views.originFiles(origin),
    trackSelection: () => views.trackSelection(),
    modDirs: () => views.facts.modDirs(),
  };
  context.subscriptions.push(
    views,
    { dispose: noticeExternalChanges(makeReporter(outputChannel, 'externalChange'), meditClient) },
    editor,
    createSourceLanguage({ client: meditClient, originFiles: (origin) => views.originFiles(origin) }),
    ...registerPluginRowCommands(pluginRowDeps),
    ...registerFilterCommands({
      client: meditClient, treeProvider,
      refreshMatchingPlugins: () => { void views.plugins.refreshFacts(); },
      showRecordFilter: views.plugins.showRecordFilter,
      reporter: makeReporter(outputChannel, 'recordFilter'),
    }),
    launchBackend({
      setting: GAME_FOLDER_SETTING, client: meditClient, enterEditing: views.enterEditing,
      exitEditing: () => exitEditing(session, meditClient), reporter: makeReporter(outputChannel, 'launch'),
      onConfigChange: vscode.workspace.onDidChangeConfiguration,
    }),
  );
}

interface PluginRowCommandDeps {
  plugins: PluginsHandle;
  client: MEditClient;
  outputChannel: vscode.LogOutputChannel;
  compileProblems: CompileProblems;
  conflictsComputed: () => Promise<void>;
  instance: Pick<Instance, 'refresh'>;
  recordWrite: RecordWrite;
  originFiles: OriginFilesOf;
  trackSelection: () => readonly unknown[];
  modDirs: TrackDeps['modDirs'];
}

function registerPluginRowCommands(deps: PluginRowCommandDeps): vscode.Disposable[] {
  const { client, outputChannel, conflictsComputed, instance, trackSelection, modDirs } = deps;
  const progress = deps.plugins.progress;
  return [
    registerTrackCommand({
      progress, instance,
      client, reporter: makeReporter(outputChannel, 'mod.track'), onTracked: conflictsComputed,
      modDirs, modsView: MODS_KEY_ARGS.view,
    }, trackSelection),
    registerDecompileCommand({
      client,
      instance,
      reporter: makeReporter(outputChannel, 'plugin.decompile'),
      ask: askQuestion,
    }, deps.plugins.selection),
    registerCompileCommand(compileDeps(deps), deps.plugins.selection),
    registerRecordCreateCommand({
      client, reporter: makeReporter(outputChannel, 'record.create'),
      write: deps.recordWrite,
      createdRecords: createdRecordSelection({
        client, reporter: makeReporter(outputChannel, 'record.create'),
        rowOf: deps.plugins.recordRow,
        view: { reveal: deps.plugins.reveal },
      }),
    }, deps.plugins.selection),
  ];
}

function compileDeps(deps: PluginRowCommandDeps): CompileDeps {
  const { client, outputChannel, compileProblems, instance, originFiles } = deps;
  return {
    client,
    instance,
    reporter: makeReporter(outputChannel, 'plugin.compile'),
    problems: compileProblems,
    originFiles,
  };
}

// VS Code's own `deactivate()` takes no arguments, so it has no way to receive what `activate()`
// built — this module-level reference exists solely to bridge that gap.
let activeClient: MEditClient | undefined;

// Async so VS Code awaits confirmed-dead-child teardown before the extension host finishes
// tearing down — otherwise a reload's replacement client is structurally unable to ever clean up
// this instance's spawned child.
export async function deactivate(): Promise<void> {
  await activeClient?.stop();
}

// The composition root (target-architecture.d2, Activation): builds every box and registers it
// with VS Code, and decides nothing. src/test/compositionRootScan.test.ts holds that.

import * as vscode from 'vscode';
import { HttpMEditClient, createLoadOrderSender, type LoadOrderSender, type MEditClient } from './client';
import { PluginTreeProvider } from './plugins/PluginTreeProvider';
import { REFERENCED_BY_VIEW, allHolders, referencedByCopyValueText } from './editor/ReferencedByTreeProvider';
import { createReferencedByView } from './editor/referencedByView';
import { makeReporter } from './reporter';
import { askQuestion } from './dialog';
import { moveToTrash } from './trash';
import { selectionInFocusedView, nexusRowInFocusedView } from './drivingLib/inFocusedView';
import { createFocusedView, type FocusedView } from './drivingLib/focusedView';
import { registerEditorCommands, announceConflictsComputed, ActiveRecordTracker, EditsInFlight } from './editor';
import { registerNameFilter, registerFilterCommands as registerNameFilterCommands, type NameFilter } from './drivingLib/nameFilter';
import { registerCopyValueCommand } from './drivingLib/copyValue';
import { reportFailure } from './drivingLib/reportFailure';
import { Instance, type InstanceValue } from './instanceLoader/instance';
import { originFiles, type OriginFilesOf } from './instanceLoader/loadOrderSnapshot';
import { dataFolderFile } from './tables/gamePaths';
import { GAME_FOLDER_SETTING } from './instanceAdapter/instanceAdapter';
import { isMo2Instance, mo2InstanceAdapter } from './instanceAdapter/mo2Instance';
import { createStatusBar, type StatusBar } from './plugins/statusBar';
import { FocusedCells, GRID_VIEW, publishFocusedCell, gridCopyValueText, type FocusedCellContext } from './editor/focusedCells';
import { meditConfig, gameDirectoryOverrides } from './workspaceConfig';
import {
  registerTrackCommand, registerDecompileCommand, registerCompileCommand, CompileProblems, type CompileDeps, type TrackDeps,
  conflictsComputedOver, refreshSourceControlFor, type PluginsViewProgress, type MinimalRepository,
} from './plugins/pluginRowCommands';
import { registerFilterCommands } from './plugins/recordFilterCommands';
import { noticeExternalChanges } from './plugins/externalChangeNotice';
import { registerRecordCreateCommand } from './plugins/createRecordCommand';
import { createdRecordSelection } from './plugins/createdRecordSelection';
import { recordWriteOver } from './plugins/recordWrite';
import { createPluginsView, type PluginsView, type PluginsViewDeps } from './plugins/pluginsView';
import { editingView } from './plugins/editingView';
import { pluginsCopyValueText, registerCreatePluginCommand } from './plugins/pluginListCommands';
import type { PluginsTreeNode, PluginsTreeProvider } from './plugins/PluginsTreeProvider';
import type { RecordWrite } from './drivingLib/writingGesture';
import { MODS_KEY_ARGS } from './mods/gestureEntry';
import type { ModListProvider, ModlistNode } from './mods/ModListProvider';
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
import { DownloadsProvider, type DownloadsTreeNode } from './downloads/DownloadsProvider';
import { downloadsCopyValueText } from './downloads/keyContext';
import { createDownloadsView } from './downloads/downloadsView';
import { ToolboxProvider } from './toolbox/ToolboxProvider';
import { registerRefreshCommand, registerToolboxCommands } from './toolbox/toolboxCommands';
import { openedFolder, whenOpened, markFirstReadLanded } from './toolbox/instanceCheck';
import type { FolderCheck } from './toolbox/folderContext';
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

// Everything activation constructs that a choke point registered elsewhere must also reach.
interface ExtensionSession {
  // The one sender of ADR-0013's snapshot.
  loadOrderSender?: LoadOrderSender;
  // Plugin filename → the `vscode.git` `Repository` for that plugin's mod folder, kept so a
  // successful field edit can prompt that repository's `status()`.
  pluginRepositories?: Map<string, MinimalRepository>;
}

// Records a disposable against its owner's teardown and hands it back. `src/test/toolboxScan.test.ts`
// fails on a registration that skips it.
type Own = <T extends vscode.Disposable>(disposable: T) => T;

// The port members every gesture, plugin sync and the launch in this file call.
type ToolboxClient = Pick<MEditClient,
  'putLoadOrder' | 'rebuildIndex' | 'createPlugin' | 'getLightPluginsSupported'
  | 'status' | 'start' | 'stop' | 'onStatusChanged' | 'onReconnected'>;

interface ToolboxDeps {
  outputChannel: vscode.LogOutputChannel;
  session: ExtensionSession;
  client: ToolboxClient;
  /** The record browser the Plugins tree's rows expand into. Built by the editing side, which
   *  owns the single instance every record surface reads through. */
  recordBrowser: PluginTreeProvider;
  /** The mEdit client's members the Plugins view reads. */
  pluginFacts: PluginsViewDeps['client'];
  statusBar: StatusBar;
  /** Fires on every completed reconcile and on a landed Track: every open record panel refetches
   *  its comparison, and every tracked mod's repo (re-)registers with `vscode.git`. */
  notifyConflictsComputed: () => void;
  /** The reporter (ADR-0019), built per tag so nothing below the entry point constructs an
   *  adapter and every gesture names itself in the log. */
  reporterFor: (tag: string) => Reporter;
  /** The one modal question every gesture below here asks through (target-architecture.d2, Ports). */
  ask: AskQuestion;
  /** The system trash every gesture below here moves a file to. */
  trash: MoveToTrash;
  /** Modbench's own extension ID, which scopes the Settings editor to its settings. */
  extensionId: string;
  /** Where the extension's own files are, the conflict table's page among them. */
  extensionUri: vscode.Uri;
  /** The view copy value and the name filter act on, which each list here makes itself by being
   *  selected in. */
  focusedView: FocusedView;
  /** The name filters of the lists built outside the Toolbox, which the catalog's filter pair reaches too. */
  viewFilters: ReadonlyMap<string, Pick<NameFilter, 'open' | 'clear'>>;
  /** Referenced By's and the record grid's own text for the catalog's one copy value id (Editor's
   *  own adapters): copy value's Mods, Plugins and Downloads adapters are this file's own. */
  referencedByCopyValueText: (clicked: unknown, allSelected: readonly unknown[] | undefined) => string | undefined;
  gridCopyValueText: (invocation: unknown) => string | undefined;
}

// What the activation reads of the Plugins view; outside an instance each member is inert.
interface PluginsHandle {
  selection: () => readonly PluginsTreeNode[];
  progress: PluginsViewProgress;
  recordRow: PluginsTreeProvider['recordRow'];
  reveal: PluginsView['view']['reveal'];
  refreshFacts: PluginsTreeProvider['refreshFacts'];
  showRecordFilter: PluginsView['showRecordFilter'];
}

// What the activation reads of the instance; outside one, nothing is tracked and a refresh is a no-op.
interface InstanceFacts {
  trackedMods: () => ReadonlySet<string>;
  modDirs: () => ReadonlyMap<string, string>;
  refresh: () => Promise<void>;
}

// The instance side's wiring: the Toolbox view and everything below `modbench.toolbox` in the
// container is built here and torn down with it. Outside an instance only the Toolbox view is
// built, and the rest is inert.
interface InstanceSide {
  /** Whether the Instance's first value has landed. Exposed for integration tests, which cannot
   *  read a context key. */
  instanceRead: () => boolean;
  /** Absent together, on the paths with no instance to read. Exposed for integration
   *  tests — production reaches all of these through the views. */
  instance?: Instance;
  modListProvider?: ModListProvider;
  downloadsProvider?: DownloadsProvider;
  pluginsTree?: PluginsTreeProvider;
  pluginListView?: PluginsView['view'];
  enterEditing?: () => Promise<void>;
  toolboxProvider: ToolboxProvider;
  facts: InstanceFacts;
  plugins: PluginsHandle;
  /** Waits for the load order the sender last sent. */
  latestSent: LoadOrderSender['latest'];
  /** Each origin's files in the value on screen; none outside an instance. */
  originFiles: OriginFilesOf;
  // Copy value's Mods and Plugins adapters.
  modListSelection: () => readonly ModlistNode[];
  pluginsSelection: () => readonly PluginsTreeNode[];
  downloadsSelection: () => readonly DownloadsTreeNode[];
  /** Track's palette Argument: the Mods or Plugins selection, whichever view was last selected in. */
  trackSelection: () => readonly unknown[];
}

type Toolbox = InstanceSide & vscode.Disposable & { folder: FolderCheck };

const ownAll = (own: Own, disposables: vscode.Disposable[]): void => {
  disposables.forEach((disposable) => own(disposable));
};

function buildBareSide(own: Own): InstanceSide {
  return {
    instanceRead: () => false,
    toolboxProvider: own(new ToolboxProvider({ instance: undefined })),
    facts: { trackedMods: () => new Set(), modDirs: () => new Map(), refresh: () => Promise.resolve() },
    plugins: {
      selection: () => [], progress: { while: (work) => work(), say: () => undefined },
      recordRow: () => Promise.resolve(undefined), reveal: () => Promise.resolve(), refreshFacts: () => Promise.resolve(undefined),
      showRecordFilter: () => undefined,
    },
    latestSent: () => Promise.resolve(undefined),
    originFiles: () => undefined,
    modListSelection: () => [], pluginsSelection: () => [], downloadsSelection: () => [],
    trackSelection: () => [],
  };
}

function buildInstanceSide(own: Own, instanceRoot: string, deps: ToolboxDeps): InstanceSide {
  const {
    outputChannel, session, client, recordBrowser, pluginFacts,
    statusBar, notifyConflictsComputed, reporterFor, ask, trash, extensionId,
  } = deps;
  // The flat log shim, for collaborators still taking a flat `(msg) => void`.
  const log = (msg: string) => outputChannel.info(msg);
  // The one Instance adapter over the instance; every consumer reaches the instance through it.
  const adapter = mo2InstanceAdapter({ instanceRoot, gameDirectoryOverrides });
  const access = { instanceRoot, adapter };
  // The instance value (ADR-0015).
  const instance = own(new Instance({
    adapter, window: vscode.window, log, logReadFailure: (line) => outputChannel.error(line),
  }));
  const firstRead = own(markFirstReadLanded(instance));
  own(refreshOnGameDirectoryChange(GAME_FOLDER_SETTING, vscode.workspace.onDidChangeConfiguration, () => instance.refresh()));
  // Fire-and-forget: watchers alone leave the value at its EMPTY sentinel until a change, so
  // this kicks off the first real read. The Plugins tree's own `sequence === 0` guard is
  // what keeps activation from being blocking here.
  void instance.refresh();
  ownAll(own, registerModDecorations(instance, vscode.workspace));
  // Held on the session as well, because the teardown writers outside this file abandon the
  // send in flight through it.
  const sender = own(createLoadOrderSender(client));
  session.loadOrderSender = sender;
  // commands.md, `refresh`: instance commands rebuild the index and send nothing; the gesture
  // itself asks the Instance loader to read every file again.
  const refreshIndex = () => refresh(client, instanceRoot, instance.value);
  // plugins.txt converges on what disk provides; the write reaches the Plugins tree and Editing's
  // Plugin load order sync through the Instance adapter's watch.
  const plugins = own(createPluginsView({
    instance, access, recordBrowser, client: pluginFacts, syncPlugins: pluginSyncOver(access), channel: outputChannel, statusBar, notifyConflictsComputed, reporterFor,
    dataFolderFile: (name) => dataFolderFile(instance.value.gameFolder, name),
    // The tree states its own severity (ADR-0019); this routes it to the matching channel level.
    log: (level, msg) => outputChannel[level](msg),
  }));
  const { tree: pluginsTree, view: pluginListView, nameFilter: pluginsFilter } = plugins;
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
  // commands.md, System commands, `modbench.instance.putLoadOrder`.
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
  own(vscode.commands.registerCommand('modbench.plugin.sync', (value: InstanceValue) => plugins.pluginSync.run(value.pluginSyncArguments)));
  const { provider: downloadsProvider, view: downloadsView, nameFilter: downloadsFilter, installDownloaded } = own(createDownloadsView({
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
      ...deps.viewFilters,
    ]),
    () => vscode.window.setStatusBarMessage('Focus a list to filter it.', 5000)));
  const trackSelection = selectionInFocusedView(
    own, deps.focusedView, ['modbench.modList', 'modbench.pluginListTree'], 'modbench.mod.trackRowsIn');
  own(registerRefreshCommand({
    refresh: refreshIndex, nextRefill: () => plugins.narrator.nextRefill(), instance, reporter: reporterFor('refresh'), instanceRoot,
  }));
  return {
    instance, instanceRead: () => firstRead.landed, modListProvider, toolboxProvider, downloadsProvider, pluginsTree, pluginListView,
    enterEditing: () => editing.enter(instance.landed()),
    facts: { trackedMods: () => instance.value.trackedMods, modDirs: () => instance.value.paths.modDirs, refresh: () => instance.refresh() },
    plugins: {
      selection: () => pluginListView.selection, progress: plugins.progress,
      recordRow: (group, formKey) => pluginsTree.recordRow(group, formKey),
      reveal: (row, options) => pluginListView.reveal(row, options),
      refreshFacts: () => pluginsTree.refreshFacts(),
      showRecordFilter: (filter) => plugins.showRecordFilter(filter),
    },
    latestSent: () => sender.latest(),
    originFiles: (origin) => originFiles(instance.value.plugins, origin),
    modListSelection: () => modListView.selection, pluginsSelection: () => pluginListView.selection,
    downloadsSelection: () => downloadsView.selection, trackSelection,
  };
}

function createToolbox(deps: ToolboxDeps): Toolbox {
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
  // Registered here, not inside buildInstanceSide: the record grid's and Referenced By's own copy
  // reach this regardless of whether the folder is an instance.
  own(registerCopyValueCommand(
    [
      { text: modsCopyValueText(side.modListSelection), reporterTag: 'mod.copyValue' },
      { text: pluginsCopyValueText(side.pluginsSelection), reporterTag: 'pluginListTree.copyValue' },
      { text: downloadsCopyValueText(side.downloadsSelection), reporterTag: 'downloadedFile.copyValue' },
      { text: deps.gridCopyValueText, reporterTag: 'recordGrid.copy' },
      { text: deps.referencedByCopyValueText, reporterTag: 'referencedByTree.copy' },
    ],
    reporterFor,
    () => deps.focusedView.id(),
    () => vscode.window.setStatusBarMessage('Focus a list or a record cell to copy its value.', 5000),
  ));

  return {
    ...side,
    folder: opened.folder,
    dispose: () => {
      owned.reverse().forEach((disposable) => { disposable.dispose(); });
      owned.length = 0;
    },
  };
}

export type ActivateExports = ReturnType<typeof activate>;

export function activate(context: vscode.ExtensionContext) {
  const session: ExtensionSession = {};
  const attachPort = meditConfig().get<number>('attachToBackendPort');

  const outputChannel = vscode.window.createOutputChannel('Modbench', { log: true });
  context.subscriptions.push(outputChannel);
  // `log` is a compat shim (defaults to .info) for modules taking a flat `(msg) => void`.
  const log = (msg: string) => outputChannel.info(msg);

  // Compile's diagnostics — one collection for every tracked mod's source files, in which
  // CompileProblems replaces a plugin's own entries each time it compiles.
  const compileDiagnostics = vscode.languages.createDiagnosticCollection('modbench-compile');
  context.subscriptions.push(compileDiagnostics);

  // ADR-0002.
  const meditClient = new HttpMEditClient({ backend: { attachPort }, backendLog: outputChannel, log });
  activeClient = meditClient; // deactivate()'s only way to reach it
  const statusBar = createStatusBar(meditClient);
  context.subscriptions.push(statusBar);
  const treeProvider = new PluginTreeProvider(meditClient, log);
  const recordPanels = new Set<vscode.WebviewPanel>();
  // The Referenced By view's input — which record panel is active and what FormKey it shows.
  const activeRecordTracker = new ActiveRecordTracker<vscode.WebviewPanel>();
  const editsInFlight = new EditsInFlight(activeRecordTracker);

  const focusedView = createFocusedView();
  const focusedCells = new FocusedCells<vscode.WebviewPanel>(
    (cell) => { publishFocusedCell(cell, (key, value) => { void vscode.commands.executeCommand('setContext', key, value); }); },
    () => focusedView.enter(GRID_VIEW));

  // Fires on every completed reconcile and on a landed Track, the one reliable point to register
  // the tracked repositories.
  const conflictsComputed = conflictsComputedOver(() => announceConflictsComputed(recordPanels, editsInFlight), {
    client: meditClient,
    outputChannel,
    setPluginRepositories: (repos) => { session.pluginRepositories = repos; },
    trackedMods: () => toolbox.facts.trackedMods(),
    modDirs: () => toolbox.facts.modDirs(),
  });
  const notifyConflictsComputed = () => { void conflictsComputed(); };
  const referencedBy = createReferencedByView(meditClient, log, registerNameFilter);
  const { provider: referencedByTreeProvider, view: referencedByTreeView } = referencedBy;
  context.subscriptions.push(
    focusedView.follow(REFERENCED_BY_VIEW, referencedByTreeView),
    referencedByTreeView.onDidChangeSelection(() => {
      void vscode.commands.executeCommand('setContext', 'modbench.referencedBy.allHolders', allHolders(referencedByTreeView.selection));
    }),
  );
  const activeRecordSubscription = activeRecordTracker.onDidChangeActiveRecord(
    (formKey) => referencedByTreeProvider.showFor(formKey));
  // Primes the view with whatever activeRecordTracker already knows — a no-op today, but it makes
  // ActiveRecordTracker.current()'s "initial state" contract true rather than aspirational.
  referencedByTreeProvider.showFor(activeRecordTracker.current());
  // The instance side, whole: the Instance, the four views, their gestures and the backend sync.
  const toolbox = createToolbox({
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
    // Copy value's Referenced By and grid adapters (commands.md, Every view) — the Toolbox owns
    // the command's one registration, alongside the other lists' gestures.
    focusedView,
    viewFilters: new Map([[REFERENCED_BY_VIEW, referencedBy.filter]]),
    referencedByCopyValueText: (clicked, allSelected) => referencedByCopyValueText(referencedByTreeView, clicked, allSelected),
    gridCopyValueText: gridCopyValueText(() => focusedCells.current()),
  });
  const instance = { refresh: () => toolbox.facts.refresh() };
  const recordWrite = recordWriteOver(instance, { latest: () => toolbox.latestSent() });
  // Its `originFiles` closes over the Toolbox and re-reads the value each call, so a compile
  // always asks the generation on screen.
  const pluginRowDeps: PluginRowCommandDeps = {
    client: meditClient, outputChannel, compileProblems: new CompileProblems(compileDiagnostics),
    conflictsComputed, instance, recordWrite, plugins: toolbox.plugins,
    originFiles: (origin) => toolbox.originFiles(origin),
    trackSelection: () => toolbox.trackSelection(),
    modDirs: () => toolbox.facts.modDirs(),
  };
  const recordViews = [
    { id: REFERENCED_BY_VIEW, selection: () => referencedByTreeView.selection },
    { id: 'modbench.pluginListTree', selection: toolbox.plugins.selection },
  ];
  context.subscriptions.push(
    toolbox,
    { dispose: noticeExternalChanges(makeReporter(outputChannel, 'externalChange'), meditClient) },
    referencedBy,
    activeRecordSubscription,
    ...registerPluginRowCommands(pluginRowDeps),
    // The record filter scopes the Plugins tree's own rows — a Plugins-view concern (its module
    // lives under plugins/), so it is wired here rather than inside Editor's own registration.
    ...registerFilterCommands({
      client: meditClient, treeProvider,
      refreshMatchingPlugins: () => { void toolbox.plugins.refreshFacts(); },
      showRecordFilter: toolbox.plugins.showRecordFilter,
      reporter: makeReporter(outputChannel, 'recordFilter'),
    }),
    ...registerEditorCommands({
      context, recordPanels, activeRecordTracker, editsInFlight, focusedCells, recordBadgeSource: treeProvider, meditClient, outputChannel,
      reporterFor: (tag) => makeReporter(outputChannel, tag),
      ask: askQuestion,
      focusedViewSelection: selectionInFocusedView(
        (disposable) => { context.subscriptions.push(disposable); return disposable; }, focusedView,
        recordViews.map(({ id }) => id), 'modbench.record.selectionIn'),
      viewSelections: new Map(recordViews.map(({ id, selection }) => [id, selection])),
      recordWrite,
      refreshSourceControlFor: (plugin, origin) => refreshSourceControlFor(session.pluginRepositories, plugin, origin, outputChannel),
    }),
    launchBackend({
      setting: GAME_FOLDER_SETTING, client: meditClient, enterEditing: toolbox.enterEditing,
      exitEditing: () => exitEditing(session, meditClient), reporter: makeReporter(outputChannel, 'launch'),
      onConfigChange: vscode.workspace.onDidChangeConfiguration,
    }),
  );

  // Exposed for integration tests — unused in production. `client`: a test drives a status
  // transition directly, outside exitEditing. `instance`: lets a test await past a sequence
  // instead of sleeping.
  return {
    folder: toolbox.folder, instanceRead: toolbox.instanceRead,
    modListProvider: toolbox.modListProvider, downloadsProvider: toolbox.downloadsProvider,
    pluginsTree: toolbox.pluginsTree,
    pluginListView: toolbox.pluginListView,
    outputChannel, enterEditing: toolbox.enterEditing, exitEditing: () => exitEditing(session, meditClient),
    client: meditClient, instance: toolbox.instance,
    // The record tab in focus reporting its focused cell, as its webview's `focusCell` does.
    focusRecordCell: (cell: FocusedCellContext) => { focusedCells.setActiveCell(cell); },
  };
}

interface PluginRowCommandDeps {
  plugins: PluginsHandle;
  client: HttpMEditClient;
  outputChannel: vscode.LogOutputChannel;
  compileProblems: CompileProblems;
  conflictsComputed: () => Promise<void>;
  instance: Pick<Instance, 'refresh'>;
  recordWrite: RecordWrite;
  originFiles: OriginFilesOf;
  trackSelection: () => readonly unknown[];
  modDirs: TrackDeps['modDirs'];
}

// One shared concern, the Plugins-tree row's own context menu, as distinct from the record
// editor's own commands (delete/copy — Editor's own registration).
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
let activeClient: HttpMEditClient | undefined;

// Async so VS Code awaits confirmed-dead-child teardown before the extension host finishes
// tearing down — otherwise a reload's replacement client is structurally unable to ever clean up
// this instance's spawned child.
export async function deactivate(): Promise<void> {
  await activeClient?.stop();
}

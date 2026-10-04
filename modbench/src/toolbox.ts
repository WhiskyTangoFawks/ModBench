import * as vscode from 'vscode';
import type { MEditClient } from './client';
import { createLoadOrderSender } from './client';
import { PluginTreeProvider } from './plugins/PluginTreeProvider';
import { Instance, type InstanceValue } from './instanceLoader/instance';
import { dataFolderFile } from './tables/gamePaths';
import { isMo2Instance, mo2InstanceAdapter } from './instanceAdapter/mo2Instance';
import type { ModListProvider, ModlistNode } from './mods/ModListProvider';
import { InactiveFileDecorationProvider } from './mods/inactiveFiles';
import { ModIndicatorDecorations } from './mods/modIndicators';
import type { PluginsTreeNode, PluginsTreeProvider } from './plugins/PluginsTreeProvider';
import { createPluginsView, type PluginsViewDeps } from './plugins/pluginsView';
import type { StatusBar } from './plugins/statusBar';
import type { Reporter } from './ports/reporter';
import type { AskQuestion } from './ports/dialog';
import type { MoveToTrash } from './ports/trash';
import { originFiles, type OriginFilesOf } from './instanceLoader/loadOrderSnapshot';
import { DownloadsProvider, type DownloadsTreeNode } from './downloads/DownloadsProvider';
import { downloadsCopyValueText } from './downloads/keyContext';
import { ToolboxProvider } from './toolbox/ToolboxProvider';
import { registerFilterCommands, type NameFilter } from './drivingLib/nameFilter';
import { registerCopyValueCommand } from './drivingLib/copyValue';
import type { FocusedView } from './drivingLib/focusedView';
import { pluginSyncOver } from './pluginsCommands/plugins';
import { loadOrderPutOnEachValue, modSyncOnEachValue, pluginSyncOnEachValue } from './syncWiring';
import { modSyncOver } from './modlist/modlist';
import { installNameRefusal } from './install/install';
import { exitEditing } from './editingTeardown';
import { registerModInstallCommands } from './mods/installCommands';
import { registerCompareFileCommand } from './mods/compareFile';
import { registerGoToModCommand } from './mods/goToMod';
import { registerConflictTable } from './mods/conflictTableEditor';
import { registerFileExclusionCommands, registerModContextCommands, registerModEnableCommands, registerModMoveCommand, registerSeparatorCommands, registerCreateEmptyModCommand, registerOpenFolderCommand, registerViewOnNexusCommand, modsCopyValueText } from './mods/modManagementCommands';
import { reportFailure } from './drivingLib/reportFailure';
import { createModsView } from './mods/modsView';
import { nexusRowInFocusedView, selectionInFocusedView } from './drivingLib/inFocusedView';
import { modRepositoryContext } from './modRepositories';
import { answerInstanceCheck, gameDirectoryOverrides, markFirstReadLanded, type FirstReadMark } from './workspaceConfig';
import type { FolderCheck } from './folderContext';
import { refreshOnGameDirectoryChange } from './gameDirectorySetting';
import { createDownloadsView } from './downloads/downloadsView';
import { registerRefreshCommand, registerToolboxCommands } from './toolbox/toolboxCommands';
import { refresh } from './instanceCommands/loadOrder';
import { editingFlow } from './instanceCommands/editing';
import type { ExtensionSession, Own } from './session';
import { pluginsCopyValueText, registerCreatePluginCommand } from './plugins/pluginListCommands';

// The port members every gesture, plugin sync and the launch in this file call.
export type ToolboxClient = Pick<MEditClient,
  'putLoadOrder' | 'rebuildIndex' | 'createPlugin' | 'getLightPluginsSupported'
  | 'status' | 'start' | 'stop' | 'onStatusChanged' | 'onReconnected'>;

export interface ToolboxDeps {
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

/** The instance side's wiring, which the activation file calls: the Toolbox view and everything
 *  below `modbench.toolbox` in the container is built here and torn down with it. */
export interface Toolbox extends vscode.Disposable {
  /** The instance check's answer, and whether the Instance's first value has landed. Exposed for
   *  integration tests, which cannot read a context key. */
  folder: FolderCheck;
  instanceRead: () => boolean;
  /** Absent together, on the paths with no instance to read. Exposed for integration
   *  tests — production reaches all of these through the views. */
  modListProvider?: ModListProvider;
  downloadsProvider?: DownloadsProvider;
  pluginsTree?: PluginsTreeProvider;
  instance?: Instance;
  enterEditing?: () => Promise<void>;
  /** Each origin's files in the value on screen; none outside an instance. */
  originFiles: OriginFilesOf;
  /** Track's palette Argument: the Mods or Plugins selection, whichever view was last selected in;
   *  none outside an instance. */
  trackSelection: () => readonly unknown[];
}

interface InstanceSide {
  instance: Instance;
  instanceRoot: string;
  firstRead: FirstReadMark;
  modListProvider: ModListProvider;
  toolboxProvider: ToolboxProvider;
  downloadsProvider: DownloadsProvider;
  pluginsTree: PluginsTreeProvider;
  enterEditing: () => Promise<void>;
  originFiles: OriginFilesOf;
  // Copy value's Mods and Plugins adapters read these once an instance exists; createToolbox falls
  // back to undefined selection outside one, the same posture as `modListProvider` and its siblings.
  modListSelection: () => readonly ModlistNode[];
  pluginsSelection: () => readonly PluginsTreeNode[];
  downloadsSelection: () => readonly DownloadsTreeNode[];
  trackSelection: () => readonly unknown[];
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
  // The Instance adapter watches files only, so an edited setting is the root's to hand to the same
  // recompute Refresh's re-read runs, once per burst under the Toolbox's own settle.
  own(refreshOnGameDirectoryChange(vscode.workspace.onDidChangeConfiguration, () => instance.refresh()));
  // Fire-and-forget: watchers alone leave the value at its EMPTY sentinel until a change, so
  // this kicks off the first real read. The Plugins tree's own `sequence === 0` guard is
  // what keeps activation from being blocking here.
  void instance.refresh();
  own(vscode.window.registerFileDecorationProvider(own(new InactiveFileDecorationProvider(instance, vscode.workspace))));
  for (const provider of own(new ModIndicatorDecorations(instance, vscode.workspace)).providers) {
    own(vscode.window.registerFileDecorationProvider(provider));
  }
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
  session.plugins = plugins;
  const { provider: modListProvider, view: modListView, nameFilter: modListFilter, modSync } = own(createModsView({
    instance, log: (line) => outputChannel.warn(`[modList] ${line}`), syncMods: modSyncOver(access), channel: outputChannel,
  }));
  own(modSyncOnEachValue(instance, modSync));
  own(pluginSyncOnEachValue(instance, plugins.pluginSync));
  const showModRepositories = (value: InstanceValue) => {
    for (const [name, mods] of Object.entries(modRepositoryContext(value))) {
      void vscode.commands.executeCommand('setContext', `modbench.mod.${name}`, mods);
    }
  };
  showModRepositories(instance.value);
  own(instance.subscribe(showModRepositories));
  const runModAction = (logLabel: string, failMessage: string, action: () => Promise<void>) =>
    reportFailure(reporterFor(logLabel), failMessage, action);
  const promptModName = (
    defaultName: string, validateInput?: (value: string) => Thenable<string | undefined> | string | undefined,
  ) =>
    vscode.window.showInputBox({ prompt: 'Mod name', value: defaultName, validateInput });
  const warnIfFomod = (name: string, isFomod: boolean) => {
    if (isFomod)
      reporterFor('install').report(
        'warning',
        `"${name}" is a FOMOD installer — its files were copied as-is and need manual ` +
          `arrangement; Modbench does not run the installer's own install steps.`,
      );
  };
  // commands.md, System commands, `modbench.instance.putLoadOrder`.
  const editing = own(editingFlow({
    client, sender, instance, instanceRoot, narrator: plugins.narrator, progress: plugins.progress, log: outputChannel,
    report: (message) => reporterFor('enterEditing').report('error', message),
    revealLog: () => outputChannel.show(true),
    leave: () => exitEditing(session, client),
  }));
  own(loadOrderPutOnEachValue(instance, editing));
  own(vscode.commands.registerCommand('modbench.instance.putLoadOrder', () => editing.put()));
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
      warnIfFomod,
      log: (line) => outputChannel.warn(`[downloads] ${line}`),
    },
    logUnresolved: (line) => outputChannel.warn(`[instance] ${line}`),
  }));
  ownAll(own, registerModInstallCommands({ access, instance, runModAction, promptModName, warnIfFomod, installDownloaded }));
  own(registerViewOnNexusCommand(instance, reporterFor('mod.viewOnNexus'), nexusRowInFocusedView(
    own, deps.focusedView, ['modbench.modList', 'modbench.downloads'], 'modbench.mod.nexusRowIn')));
  own(deps.focusedView.follow('modbench.modList', modListView));
  own(deps.focusedView.follow('modbench.pluginListTree', pluginListView));
  own(deps.focusedView.follow('modbench.downloads', downloadsView));
  ownAll(own, registerFilterCommands(
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
    instance, instanceRoot, firstRead, modListProvider, toolboxProvider, downloadsProvider, pluginsTree, enterEditing: () => editing.enter(),
    originFiles: (origin) => originFiles(instance.value.plugins, origin),
    modListSelection: () => modListView.selection, pluginsSelection: () => pluginListView.selection,
    downloadsSelection: () => downloadsView.selection, trackSelection,
  };
}

const ownAll = (own: Own, disposables: vscode.Disposable[]): void => {
  for (const disposable of disposables) own(disposable);
};

type OpenedFolder = { folder: 'instance'; instanceRoot: string } | { folder: 'notAnInstance' };

// Outside an instance only the Toolbox registers, row-less, and each view's `viewsWelcome` says
// why. An instance whose files cannot be read is still an instance: its views show the error row
// (common.md, States, stories 2 and 4).
function openedFolder(outputChannel: vscode.LogOutputChannel): OpenedFolder {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const folder = answerInstanceCheck(root, isMo2Instance);
  if (folder === 'instance' && root !== undefined) return { folder, instanceRoot: root };
  const what = root === undefined ? 'No folder is open' : `"${root}" is not an instance`;
  outputChannel.info(`[toolbox] ${what}; every view says how to open one.`);
  return { folder: 'notAnInstance' };
}

export function createToolbox(deps: ToolboxDeps): Toolbox {
  const { client, reporterFor } = deps;
  const owned: vscode.Disposable[] = [];
  const own: Own = (disposable) => {
    owned.push(disposable);
    return disposable;
  };

  const opened = openedFolder(deps.outputChannel);
  const side = opened.folder === 'instance' ? buildInstanceSide(own, opened.instanceRoot, deps) : undefined;

  const provider = side?.toolboxProvider ?? own(new ToolboxProvider({ instance: undefined }));
  const toolboxView = own(vscode.window.createTreeView('modbench.toolbox', { treeDataProvider: provider }));
  const showMessage = () => { toolboxView.message = provider.viewMessage(); };
  showMessage();
  own(provider.onDidChangeTreeData(showMessage));
  own(registerCreatePluginCommand(client, side?.instance, reporterFor('newPlugin')));
  // Registered here, not inside buildInstanceSide: the record grid's and Referenced By's own copy
  // reach this regardless of whether the folder is an instance.
  own(registerCopyValueCommand(
    [
      { text: side ? modsCopyValueText(() => side.modListSelection()) : () => undefined, reporterTag: 'mod.copyValue' },
      { text: side ? pluginsCopyValueText(() => side.pluginsSelection()) : () => undefined, reporterTag: 'pluginListTree.copyValue' },
      { text: side ? downloadsCopyValueText(() => side.downloadsSelection()) : () => undefined, reporterTag: 'downloadedFile.copyValue' },
      { text: deps.gridCopyValueText, reporterTag: 'recordGrid.copy' },
      { text: deps.referencedByCopyValueText, reporterTag: 'referencedByTree.copy' },
    ],
    reporterFor,
    () => deps.focusedView.id(),
    () => vscode.window.setStatusBarMessage('Focus a list or a record cell to copy its value.', 5000),
  ));

  return {
    folder: opened.folder,
    instanceRead: () => side?.firstRead.landed ?? false,
    modListProvider: side?.modListProvider,
    downloadsProvider: side?.downloadsProvider,
    pluginsTree: side?.pluginsTree,
    instance: side?.instance,
    enterEditing: side?.enterEditing,
    originFiles: (origin) => side?.originFiles(origin),
    trackSelection: () => side?.trackSelection() ?? [],
    dispose: () => {
      for (const disposable of owned.reverse()) disposable.dispose();
      owned.length = 0;
    },
  };
}

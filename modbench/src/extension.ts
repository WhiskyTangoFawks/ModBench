// The composition root (target-architecture.d2, Activation): builds every box and registers it
// with VS Code, and decides nothing: eslint.config.mjs holds that.

import * as vscode from 'vscode';
import { createMEditClient, stopMEditClient, type MEditClient, type ReadModStatus } from './client';
import { makeReporter } from './reporter';
import { askQuestion } from './dialog';
import { moveToTrash } from './trash';
import { selectionInFocusedView, nexusRowInFocusedView } from './drivingLib/inFocusedView';
import { createFocusedView, type FocusedView } from './drivingLib/focusedView';
import { createEditor, sourceModRepositoriesOver, type Editor } from './editor';
import { createSourceLanguage, formKeyLocation } from './sourceLanguage';
import { saveModPluginSource } from './sourceLanguage/dirtyPluginSource';
import { registerFilterCommands as registerNameFilterCommands } from './drivingLib/nameFilter';
import { registerCopyValueCommand, type CopyValueAdapter } from './drivingLib/copyValue';
import type { SourceEditing } from './drivingLib/sourceEditing';
import { applyWorkspaceChanges } from './drivingLib/applyWorkspaceChanges';
import { oneAtATime } from './drivingLib/oneAtATime';
import { Instance } from './instanceLoader/instance';
import { factsOf, NO_INSTANCE_FACTS, type InstanceFacts } from './instanceLoader/instanceFacts';
import { sourceFiles, NO_SOURCE_FILES, type SourceFilesOf } from './instanceLoader/loadOrderSnapshot';
import { dataFolderFile } from './tables/gamePaths';
import { isMo2Instance, mo2InstanceAdapter } from './instanceAdapter/mo2Instance';
import { sevenZip, type InstanceAdapter } from './instanceAdapter/instanceAdapter';
import { serveAgent } from './agent/agentServer';
import { agentPort, attachPort, gameDirectoryOverrides, inheritedPythonPath, onGameDirectoryChange, onStringsLanguageChange, onTerminalEnvChange, stringsLanguage } from './workspaceConfig';
import { createPlugins, PLUGINS_KEY_ARGS, type Plugins } from './plugins';
import { createModsView } from './mods/modsView';
import type { DownloadsTreeNode } from './downloads/DownloadsProvider';
import { DOWNLOADS_KEY_ARGS, downloadsCopyValueText } from './downloads/keyContext';
import { createDownloadsView } from './downloads/downloadsView';
import { ToolboxProvider } from './toolbox/ToolboxProvider';
import { initRepositoryIn } from './instanceRepository';
import { registerModlistCommands } from './toolbox/modlistGestures';
import { publishRepository } from './toolbox/repositoryContext';
import { registerRefreshCommand, registerToolboxCommands } from './toolbox/toolboxCommands';
import { openedFolder, whenOpened } from './toolbox/instanceCheck';
import { markFirstReadLanded } from './drivingLib/instanceFirstRead';
import { pluginCommands, pluginSyncOver } from './pluginCommands/plugins';
import { modlistRepositoryCommands } from './sourceCommands/modlistRepositoryCommands';
import { sourceCommands } from './sourceCommands/sourceCommands';
import { modSyncOver, modCommands } from './modCommands/modCommands';
import { warnIfFomod } from './mods/fomodWarning';
import { downloadedFileCommands } from './downloadedFileCommands/downloads';
import { instanceCommands } from './instanceCommands/instanceCommands';
import { reachMEditFromTerminals } from './terminalEnvironment';
import { openWalkthroughOnce } from './walkthrough';
import { instanceSyncs, loadOrderPutHandler, loadOrderPutOnEachLanguageChange, loadOrderPutOnEachValue } from './syncWiring';
import type { Reporter } from './ports/reporter';
import type { AskQuestion } from './ports/dialog';
import type { MoveToTrash } from './ports/trash';

// Records a disposable against its owner's teardown and hands it back. `src/test/toolboxScan.test.ts`
// fails on a registration that skips it.
type Own = <T extends vscode.Disposable>(disposable: T) => T;

type ViewsClient = Pick<MEditClient,
  'sendLoadOrder' | 'onLoadOrderResent' | 'latestLoadOrder' | 'onLaunch' | 'onExit' | 'start' | 'rebuildIndex'
  | 'getModStatus' | 'onNotification' | 'onReconnected' | 'getPlugins' | 'getRenameSourceChanges' | 'moveLastWritten' | 'getPluginDependants' | 'getCreatablePluginExtensions' | 'build' | 'init' | 'updateManifest' | 'restoreFromManifest' | 'getWhatRestoreDestroys' | 'changeBuildConfiguration'>;

interface ViewsDeps {
  outputChannel: vscode.LogOutputChannel;
  client: ViewsClient;
  plugins: Plugins;
  registerRepositories: () => Promise<void>;
  reporterFor: (tag: string) => Reporter;
  ask: AskQuestion;
  trash: MoveToTrash;
  extensionId: string;
  extensionUri: vscode.Uri;
  focusedView: FocusedView;
  editor: Pick<Editor, 'copyValue'>;
}

interface InstanceSide {
  /** Absent together, on the path with no instance to read. */
  instance?: Instance;
  readStatus?: ReadModStatus;
  toolboxProvider: ToolboxProvider;
  sourceFiles: SourceFilesOf;
  copyValue: CopyValueAdapter[];
  downloadsSelection: () => readonly DownloadsTreeNode[];
}

type Views = InstanceSide & vscode.Disposable;

const ownAll = (own: Own, disposables: vscode.Disposable[]): void => {
  own(vscode.Disposable.from(...disposables));
};

function buildBareSide(own: Own): InstanceSide {
  return {
    toolboxProvider: own(new ToolboxProvider({ instance: undefined })),
    sourceFiles: NO_SOURCE_FILES,
    copyValue: [], downloadsSelection: () => [],
  };
}

interface OpenedInstance {
  instanceRoot: string;
  adapter: InstanceAdapter;
  instance: Instance;
}

interface Opened {
  facts: InstanceFacts;
  side: (own: Own, deps: ViewsDeps) => InstanceSide;
}

function openInstance(outputChannel: vscode.LogOutputChannel, own: Own): Opened {
  return whenOpened<Opened>(openedFolder(isMo2Instance, (line) => outputChannel.info(line)), {
    instance: (instanceRoot) => {
      const adapter = mo2InstanceAdapter({
        instanceRoot, gameDirectoryOverrides, gameDirectoryChanged: onGameDirectoryChange, archives: sevenZip,
      });
      const instance = own(new Instance({
        adapter, window: vscode.window, log: outputChannel,
      }));
      return { facts: factsOf(instance), side: (own, deps) => buildInstanceSide(own, { instanceRoot, adapter, instance }, deps) };
    },
    notAnInstance: () => ({ facts: NO_INSTANCE_FACTS, side: buildBareSide }),
  });
}

function buildInstanceSide(own: Own, { instanceRoot, adapter, instance }: OpenedInstance, deps: ViewsDeps): InstanceSide {
  const { outputChannel, client, plugins: pluginsBox, reporterFor, ask, trash, extensionId } = deps;
  own(markFirstReadLanded(instance));
  const commands = instanceCommands({ adapter, client, instanceRoot });
  const { modSync, pluginSync } = own(instanceSyncs({
    instance, syncMods: modSyncOver(adapter), syncPlugins: pluginSyncOver(adapter), channel: outputChannel,
  }));
  const sourceGestureRows = selectionInFocusedView(
    own, deps.focusedView, ['modbench.modList', 'modbench.pluginListTree'], 'modbench.mod.sourceGestureRowsIn');
  const plugins = own(pluginsBox.onInstance({
    instance, instanceRoot, commands: pluginCommands({ adapter, client }), pluginSync,
    dataFolderFile: (name) => dataFolderFile(instance.value.gameFolder, name),
  }));
  const fomodWarning = warnIfFomod(reporterFor('install'));
  const { view: downloadsView, nameFilter: downloadsFilter } = own(createDownloadsView({
    commands: downloadedFileCommands(adapter), instance, reporter: reporterFor('downloadList'), ask, trash,
    log: (line) => outputChannel.warn(`[downloads] ${line}`),
    logUnresolved: (line) => outputChannel.warn(`[instance] ${line}`),
  }));
  const toolboxProvider = own(new ToolboxProvider({ instance, channel: outputChannel }));
  const modlist = modlistRepositoryCommands({ client, adapter, instanceRoot, makeRepository: () => initRepositoryIn(instanceRoot), trash });
  const readStatus: ReadModStatus = (names) => modlist.modStatus(names);
  const mods = own(createModsView({
    instance, commands: modCommands(adapter, client, readStatus), log: (line) => outputChannel.warn(`[modList] ${line}`), modSync, reporterFor, ask, trash,
    extensionUri: deps.extensionUri, warnIfFomod: fomodWarning,
    downloadInstall: {
      reporter: reporterFor('downloadList'), log: (line) => outputChannel.warn(`[downloads] ${line}`),
      progressViewId: DOWNLOADS_KEY_ARGS.view,
    },
    nexusRow: nexusRowInFocusedView(own, deps.focusedView, ['modbench.modList', 'modbench.downloads'], 'modbench.mod.nexusRowIn'),
    sourceGestures: {
      commands: sourceCommands({ client, adapter }), rows: sourceGestureRows, pluginsView: PLUGINS_KEY_ARGS.view, say: plugins.say,
      saveUnsavedPluginSource: (mod) => saveModPluginSource((origin) => sourceFiles(instance.value, origin), mod),
      registerRepositories: deps.registerRepositories,
    },
    manifestGestures: { commands: modlist, say: (message) => { toolboxProvider.say(message); }, focusedView: deps.focusedView },
    modStatus: { push: client, readStatus },
  }));
  const { editing } = plugins;
  void editing.enter(instance.landed());
  void client.start();
  const putLoadOrder = loadOrderPutHandler(editing, stringsLanguage);
  own(loadOrderPutOnEachValue(instance, putLoadOrder));
  own(loadOrderPutOnEachLanguageChange(onStringsLanguageChange, instance, putLoadOrder));
  own(vscode.commands.registerCommand('modbench.instance.putLoadOrder', putLoadOrder));
  ownAll(own, registerToolboxCommands({ commands, instance, extensionId, reporterFor }));
  own(publishRepository(instance, instanceRoot));
  ownAll(own, registerModlistCommands({ commands: modlist, instance, reporter: reporterFor('modlist') }));
  own(deps.focusedView.follow('modbench.modList', mods.view));
  own(deps.focusedView.follow('modbench.pluginListTree', plugins.followed));
  own(deps.focusedView.follow('modbench.downloads', downloadsView));
  ownAll(own, registerNameFilterCommands(
    () => deps.focusedView.id(),
    new Map([
      ['modbench.modList', mods.nameFilter], ['modbench.pluginListTree', plugins.nameFilter], ['modbench.downloads', downloadsFilter],
    ]),
    () => vscode.window.setStatusBarMessage('Focus a list to filter it.', 5000)));
  own(registerRefreshCommand({
    commands, nextRefill: plugins.nextRefill, instance, reporter: reporterFor('refresh'), instanceRoot,
  }));
  return {
    instance, toolboxProvider, readStatus,
    sourceFiles: (origin) => sourceFiles(instance.value, origin),
    copyValue: [mods.copyValue, plugins.copyValue],
    downloadsSelection: () => downloadsView.selection,
  };
}

function ownership(): { own: Own; dispose: () => void } {
  const owned: vscode.Disposable[] = [];
  const own: Own = (disposable) => {
    owned.push(disposable);
    return disposable;
  };
  return { own, dispose: () => { vscode.Disposable.from(...owned.splice(0).reverse()).dispose(); } };
}

function buildViews(opened: Opened, { own, dispose }: ReturnType<typeof ownership>, deps: ViewsDeps): Views {
  const { reporterFor } = deps;

  const side = opened.side(own, deps);

  const toolboxView = own(vscode.window.createTreeView('modbench.toolbox', { treeDataProvider: side.toolboxProvider }));
  const showMessage = () => { toolboxView.message = side.toolboxProvider.viewMessage(); };
  showMessage();
  own(side.toolboxProvider.onDidChangeTreeData(showMessage));
  own(registerCopyValueCommand(
    [
      ...side.copyValue,
      { text: downloadsCopyValueText(side.downloadsSelection), reporterTag: 'downloadedFile.copyValue' },
      ...deps.editor.copyValue,
    ],
    reporterFor,
    () => deps.focusedView.id(),
    () => vscode.window.setStatusBarMessage('Focus a list or a record cell to copy its value.', 5000),
  ));

  return {
    ...side,
    dispose,
  };
}

export function activate(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel('Modbench', { log: true });
  context.subscriptions.push(outputChannel);

  // ADR-0002.
  const meditClient = createMEditClient({ backend: { attachPort: attachPort() }, backendLog: outputChannel, log: outputChannel });
  const focusedView = createFocusedView();

  const ownedByViews = ownership();
  const opened = openInstance(outputChannel, ownedByViews.own);
  const sourceModRepositories = sourceModRepositoriesOver({ client: meditClient, outputChannel, ...opened.facts });
  const sourceEditing: SourceEditing = {
    applyWorkspaceChanges: (items) => applyWorkspaceChanges(items),
    oneAtATime: oneAtATime(),
    refreshSourceControlFor: sourceModRepositories.refreshSourceControlFor,
  };
  const reporterFor = (tag: string) => makeReporter(outputChannel, tag);
  const plugins = createPlugins({
    client: meditClient, facts: opened.facts, channel: outputChannel, reporterFor,
    registerRepositories: sourceModRepositories.registerRepositories, ask: askQuestion, sourceEditing,
  });
  const editor = createEditor({
    context, meditClient, outputChannel,
    reporterFor,
    ask: askQuestion,
    focusedView,
    recordViewIds: ['modbench.pluginListTree'],
    recordWrite: plugins.recordWrite,
    sourceEditing,
    modFacts: opened.facts,
    locateRecord: formKeyLocation(meditClient),
    conditionsOf: (plugin) => plugins.conditionsOf(plugin),
  });
  const views = buildViews(opened, ownedByViews, {
    outputChannel, client: meditClient,
    reporterFor,
    ask: askQuestion,
    trash: moveToTrash,
    plugins, registerRepositories: sourceModRepositories.registerRepositories,
    extensionId: context.extension.id,
    extensionUri: context.extensionUri,
    focusedView,
    editor,
  });
  context.subscriptions.push(
    views,
    plugins,
    editor,
    serveAgent({ port: agentPort(), instance: views.instance, readStatus: views.readStatus, mEdit: meditClient, terminalEnvironment: context.environmentVariableCollection, reporter: reporterFor('agent'), log: outputChannel }),
    reachMEditFromTerminals(context.environmentVariableCollection, meditClient, vscode.Uri.joinPath(context.extensionUri, 'scripts').fsPath, inheritedPythonPath, onTerminalEnvChange),
    createSourceLanguage({
      client: meditClient, sourceFiles: (origin) => views.sourceFiles(origin), reporter: makeReporter(outputChannel, 'sourceLanguage'),
    }),
  );
  void openWalkthroughOnce(context.globalState, context.extension.id, (walkthrough) => vscode.commands.executeCommand('workbench.action.openWalkthrough', walkthrough, false));
}

// Async so VS Code awaits confirmed-dead-child teardown before the extension host finishes
// tearing down — otherwise a reload's replacement client is structurally unable to ever clean up
// this instance's spawned child.
export async function deactivate(): Promise<void> {
  await stopMEditClient();
}

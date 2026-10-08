// The composition root (target-architecture.d2, Activation): builds every box and registers it
// with VS Code, and decides nothing: eslint.config.mjs holds that.

import * as vscode from 'vscode';
import { createMEditClient, stopMEditClient, type MEditClient } from './client';
import { RecordBrowser } from './plugins/RecordBrowser';
import { makeReporter } from './reporter';
import { askQuestion } from './dialog';
import { moveToTrash } from './trash';
import { selectionInFocusedView, nexusRowInFocusedView } from './drivingLib/inFocusedView';
import { createFocusedView, type FocusedView } from './drivingLib/focusedView';
import { createEditor, trackedRepositoriesOver, type Editor } from './editor';
import { createSourceLanguage } from './sourceLanguage';
import { registerFilterCommands as registerNameFilterCommands } from './drivingLib/nameFilter';
import { registerCopyValueCommand, type CopyValueAdapter } from './drivingLib/copyValue';
import type { RecordWrite } from './drivingLib/writingGesture';
import { Instance } from './instanceLoader/instance';
import { factsOf, NO_INSTANCE_FACTS, type InstanceFacts } from './instanceLoader/instanceFacts';
import { originFiles, NO_ORIGIN_FILES, type OriginFilesOf } from './instanceLoader/loadOrderSnapshot';
import { dataFolderFile } from './tables/gamePaths';
import { isMo2Instance, mo2InstanceAdapter } from './instanceAdapter/mo2Instance';
import { createStatusBar, type StatusBar } from './plugins/statusBar';
import { meditConfig, gameDirectoryOverrides, onGameDirectoryChange } from './workspaceConfig';
import { noticeExternalChanges } from './plugins/externalChangeNotice';
import { recordWriteOver } from './plugins/recordWrite';
import { createPluginsView, type PluginsViewDeps } from './plugins/pluginsView';
import { editingView } from './plugins/editingView';
import { MODS_KEY_ARGS } from './mods/gestureEntry';
import { createModsView } from './mods/modsView';
import type { DownloadsTreeNode } from './downloads/DownloadsProvider';
import { DOWNLOADS_KEY_ARGS, downloadsCopyValueText } from './downloads/keyContext';
import { createDownloadsView } from './downloads/downloadsView';
import { ToolboxProvider } from './toolbox/ToolboxProvider';
import { registerRefreshCommand, registerToolboxCommands } from './toolbox/toolboxCommands';
import { openedFolder, whenOpened } from './drivingLib/instanceCheck';
import { markFirstReadLanded } from './drivingLib/instanceFirstRead';
import { pluginSyncOver } from './pluginsCommands/plugins';
import { modSyncOver } from './modlist/modlist';
import { warnIfFomod } from './install/fomodWarning';
import { refresh } from './instanceCommands/loadOrder';
import { editingFlow } from './instanceCommands/editing';
import { instanceSyncs, loadOrderPutHandler, loadOrderPutOnEachValue } from './syncWiring';
import type { Reporter } from './ports/reporter';
import type { AskQuestion } from './ports/dialog';
import type { MoveToTrash } from './ports/trash';

// Records a disposable against its owner's teardown and hands it back. `src/test/toolboxScan.test.ts`
// fails on a registration that skips it.
type Own = <T extends vscode.Disposable>(disposable: T) => T;

type ViewsClient = Pick<MEditClient,
  'sendLoadOrder' | 'onLoadOrderResent' | 'latestLoadOrder' | 'onLaunch' | 'start' | 'rebuildIndex'>;

interface ViewsDeps {
  outputChannel: vscode.LogOutputChannel;
  client: ViewsClient;
  recordBrowser: RecordBrowser;
  pluginFacts: PluginsViewDeps['client'];
  statusBar: StatusBar;
  conflictsComputed: () => Promise<void>;
  recordWrite: RecordWrite;
  reporterFor: (tag: string) => Reporter;
  ask: AskQuestion;
  trash: MoveToTrash;
  extensionId: string;
  extensionUri: vscode.Uri;
  focusedView: FocusedView;
  editor: Pick<Editor, 'nameFilters' | 'copyValue'>;
}

interface InstanceSide {
  /** Absent together, on the path with no instance to read. */
  instance?: Instance;
  toolboxProvider: ToolboxProvider;
  facts: InstanceFacts;
  originFiles: OriginFilesOf;
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
    facts: NO_INSTANCE_FACTS,
    originFiles: NO_ORIGIN_FILES,
    copyValue: [], downloadsSelection: () => [],
  };
}

function buildInstanceSide(own: Own, instanceRoot: string, deps: ViewsDeps): InstanceSide {
  const {
    outputChannel, client, recordBrowser, pluginFacts,
    statusBar, conflictsComputed, recordWrite, reporterFor, ask, trash, extensionId,
  } = deps;
  const log = (msg: string) => outputChannel.info(msg);
  const adapter = mo2InstanceAdapter({ instanceRoot, gameDirectoryOverrides, gameDirectoryChanged: onGameDirectoryChange });
  const access = { instanceRoot, adapter };
  const instance = own(new Instance({
    adapter, window: vscode.window, log, logReadFailure: (line) => outputChannel.error(line),
  }));
  own(markFirstReadLanded(instance));
  const refreshIndex = () => refresh(client, instanceRoot, instance.value);
  const { modSync, pluginSync } = own(instanceSyncs({
    instance, syncMods: modSyncOver(access), syncPlugins: pluginSyncOver(access), channel: outputChannel,
  }));
  const trackSelection = selectionInFocusedView(
    own, deps.focusedView, ['modbench.modList', 'modbench.pluginListTree'], 'modbench.mod.trackRowsIn');
  const plugins = own(createPluginsView({
    instance, access, recordBrowser, client: pluginFacts, pluginSync, channel: outputChannel, statusBar, conflictsComputed, reporterFor,
    ask, recordWrite, trackSelection, modsView: MODS_KEY_ARGS.view,
    dataFolderFile: (name) => dataFolderFile(instance.value.gameFolder, name),
    log: (level, msg) => outputChannel[level](msg),
  }));
  const fomodWarning = warnIfFomod(reporterFor('install'));
  const { view: downloadsView, nameFilter: downloadsFilter } = own(createDownloadsView({
    access, instance, reporter: reporterFor('downloadList'), ask, trash,
    log: (line) => outputChannel.warn(`[downloads] ${line}`),
    logUnresolved: (line) => outputChannel.warn(`[instance] ${line}`),
  }));
  const mods = own(createModsView({
    instance, access, log: (line) => outputChannel.warn(`[modList] ${line}`), modSync, reporterFor, ask, trash,
    extensionUri: deps.extensionUri, warnIfFomod: fomodWarning,
    downloadInstall: {
      reporter: reporterFor('downloadList'), log: (line) => outputChannel.warn(`[downloads] ${line}`),
      progressViewId: DOWNLOADS_KEY_ARGS.view,
    },
    nexusRow: nexusRowInFocusedView(own, deps.focusedView, ['modbench.modList', 'modbench.downloads'], 'modbench.mod.nexusRowIn'),
  }));
  const view = editingView({
    narrator: plugins.narrator, progress: plugins.progress, log: outputChannel, revealLog: () => outputChannel.show(true), loadOrderPut: plugins.loadOrderPut,
    reportPut: (message) => reporterFor('loadOrder').report('error', message),
    reportEntry: (message) => reporterFor('enterEditing').report('error', message),
    reportLaunch: (message, reason) => reporterFor('launch').report('error', message, reason),
  });
  const editing = own(editingFlow({
    client, instanceRoot, around: view.around, tell: view.tell, log: (line) => outputChannel.error(line),
  }));
  void editing.enter(instance.landed());
  void client.start();
  const putLoadOrder = loadOrderPutHandler(editing);
  own(loadOrderPutOnEachValue(instance, putLoadOrder));
  own(vscode.commands.registerCommand('modbench.instance.putLoadOrder', putLoadOrder));
  const toolboxProvider = own(new ToolboxProvider({ instance, channel: outputChannel }));
  ownAll(own, registerToolboxCommands({ access, instance, extensionId, reporterFor }));
  own(deps.focusedView.follow('modbench.modList', mods.view));
  own(deps.focusedView.follow('modbench.pluginListTree', plugins.followed));
  own(deps.focusedView.follow('modbench.downloads', downloadsView));
  ownAll(own, registerNameFilterCommands(
    () => deps.focusedView.id(),
    new Map([
      ['modbench.modList', mods.nameFilter], ['modbench.pluginListTree', plugins.nameFilter], ['modbench.downloads', downloadsFilter],
      ...deps.editor.nameFilters,
    ]),
    () => vscode.window.setStatusBarMessage('Focus a list to filter it.', 5000)));
  own(registerRefreshCommand({
    refresh: refreshIndex, nextRefill: () => plugins.narrator.nextRefill(), instance, reporter: reporterFor('refresh'), instanceRoot,
  }));
  return {
    instance, toolboxProvider,
    facts: factsOf(instance),
    originFiles: (origin) => originFiles(instance.value, origin),
    copyValue: [mods.copyValue, plugins.copyValue],
    downloadsSelection: () => downloadsView.selection,
  };
}

function buildViews(deps: ViewsDeps): Views {
  const { reporterFor } = deps;
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
    dispose: () => {
      vscode.Disposable.from(...owned.splice(0).reverse()).dispose();
    },
  };
}

export function activate(context: vscode.ExtensionContext): void {
  const attachPort = meditConfig().get<number>('attachToBackendPort');

  const outputChannel = vscode.window.createOutputChannel('Modbench', { log: true });
  context.subscriptions.push(outputChannel);
  const log = (msg: string) => outputChannel.info(msg);

  // ADR-0002.
  const meditClient = createMEditClient({ backend: { attachPort }, backendLog: outputChannel, log });
  const statusBar = createStatusBar(meditClient);
  context.subscriptions.push(statusBar);
  const treeProvider = new RecordBrowser(meditClient, log);
  const focusedView = createFocusedView();

  const modFacts = {
    trackedMods: () => views.facts.trackedMods(), modDirs: () => views.facts.modDirs(), onChange: (listener: () => void) => views.facts.onChange(listener),
  };
  const trackedRepositories = trackedRepositoriesOver({ client: meditClient, outputChannel, ...modFacts });
  const instance = { refresh: () => views.facts.refresh() };
  const recordWrite = recordWriteOver(instance, meditClient);
  const editor = createEditor({
    context, meditClient, outputChannel,
    reporterFor: (tag) => makeReporter(outputChannel, tag),
    ask: askQuestion,
    focusedView,
    recordViewIds: ['modbench.pluginListTree'],
    recordWrite,
    refreshSourceControlFor: trackedRepositories.refreshSourceControlFor,
    modFacts,
  });
  const conflictsComputed = trackedRepositories.conflictsComputedOver(() => { editor.announceConflictsComputed(); });
  const views = buildViews({
    outputChannel, client: meditClient,
    reporterFor: (tag) => makeReporter(outputChannel, tag),
    ask: askQuestion,
    trash: moveToTrash,
    recordBrowser: treeProvider,
    pluginFacts: meditClient,
    statusBar,
    conflictsComputed,
    recordWrite,
    extensionId: context.extension.id,
    extensionUri: context.extensionUri,
    focusedView,
    editor,
  });
  context.subscriptions.push(
    views,
    { dispose: noticeExternalChanges(makeReporter(outputChannel, 'externalChange'), meditClient) },
    editor,
    createSourceLanguage({
      client: meditClient, originFiles: (origin) => views.originFiles(origin), reporter: makeReporter(outputChannel, 'sourceLanguage'),
    }),
  );
}

// Async so VS Code awaits confirmed-dead-child teardown before the extension host finishes
// tearing down — otherwise a reload's replacement client is structurally unable to ever clean up
// this instance's spawned child.
export async function deactivate(): Promise<void> {
  await stopMEditClient();
}

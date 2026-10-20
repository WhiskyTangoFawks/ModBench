// The composition root (target-architecture.d2, Activation): builds every box and registers it
// with VS Code, and decides nothing: eslint.config.mjs holds that.

import * as vscode from 'vscode';
import { createMEditClient, stopMEditClient, type MEditClient, type ReadModStatus } from './client';
import { makeReporter } from './drivingLib/reporter';
import { askQuestion } from './dialog';
import { moveToTrash } from './trash';
import { selectionInFocusedView, nexusRowInFocusedView } from './drivingLib/inFocusedView';
import { createFocusedView, type FocusedView } from './drivingLib/focusedView';
import { createEditor, loadOrderComing, sourceModRepositoriesOver, type Editor } from './editor';
import { createSourceLanguage, formKeyLocation } from './sourceLanguage';
import { saveUnsavedPluginSource } from './textDocuments/saveUnsavedPluginSource';
import { registerFilterCommands as registerNameFilterCommands } from './drivingLib/nameFilter';
import { registerCopyValueCommand, type CopyValueAdapter } from './drivingLib/copyValue';
import type { SourceEditing } from './textDocuments/sourceEditing';
import { applyWorkspaceChanges } from './textDocuments/applyWorkspaceChanges';
import { oneAtATime } from './textDocuments/oneAtATime';
import { Instance } from './instanceLoader/instance';
import { factsOf, NO_INSTANCE_FACTS, type InstanceFacts } from './instanceLoader/instanceFacts';
import { sourceFiles, NO_SOURCE_FILES, type SourceFilesOf } from './instanceLoader/loadOrderSnapshot';
import { isMo2Instance, mo2InstanceAdapter } from './instanceAdapter/mo2Instance';
import { downloadedFileReader, type InstanceAdapter } from './instanceAdapter/instanceAdapter';
import { serveAgent } from './agent/agentServer';
import { agentPort } from './agent/agentPort';
import { attachPort, gameFolderSetting, onStringsLanguageChange, stringsLanguage } from './workspaceConfig';
import { createPlugins, PLUGINS_KEY_ARGS, type Plugins } from './plugins';
import { MODS_KEY_ARGS } from './mods/gestureEntry';
import { createModsView } from './mods/modsView';
import type { DownloadsTreeNode } from './downloads/DownloadsProvider';
import { DOWNLOADS_KEY_ARGS, downloadsCopyValueText } from './downloads/keyContext';
import { createDownloadsView } from './downloads/downloadsView';
import { createToolboxView, type ToolboxView } from './toolbox/toolboxView';
import { initRepositoryIn } from './instanceRepository';
import { registerModlistCommands } from './toolbox/modlistGestures';
import { publishRepository } from './toolbox/repositoryContext';
import { registerRefreshCommand, registerToolboxCommands, TOOLBOX_VIEW } from './toolbox/toolboxCommands';
import { openedFolder, whenOpened } from './toolbox/instanceCheck';
import { markFirstReadLanded } from './drivingLib/instanceFirstRead';
import { pluginCommands, pluginSyncOver } from './pluginCommands/plugins';
import { modlistRepositoryCommands } from './sourceCommands/modlistRepositoryCommands';
import { sourceCommands } from './sourceCommands/sourceCommands';
import { modSyncOver, modCommands } from './modCommands/modCommands';
import { warnIfFomod } from './mods/fomodWarning';
import { downloadedFileCommands } from './downloadedFileCommands/downloads';
import { editingFlow } from './instanceCommands/editing';
import { instanceCommands } from './instanceCommands/instanceCommands';
import { reachMEditFromTerminals } from './agent/terminalEnvironment';
import { openWalkthroughOnce } from './walkthrough';
import { instanceSyncs, registerSyncCommands, loadOrderPutHandler, loadOrderPutOnEachLanguageChange, loadOrderPutOnEachValue } from './syncWiring';
import type { Reporter } from './ports/reporter';
import type { AskQuestion } from './ports/dialog';
import type { MoveToTrash } from './ports/trash';

// Records a disposable against its owner's teardown and hands it back. `src/test/toolboxScan.test.ts`
// fails on a registration that skips it.
type Own = <T extends vscode.Disposable>(disposable: T) => T;

type ViewsClient = Pick<MEditClient,
  'sendLoadOrder' | 'onLoadOrderResent' | 'latestLoadOrder' | 'onLaunch' | 'onExit' | 'start' | 'rebuildIndex'
  | 'getModStatus' | 'onNotification' | 'onReconnected' | 'getPlugins' | 'getRenameSourceChanges' | 'moveLastWritten' | 'getPluginDependants' | 'getCreatablePluginExtensions' | 'build' | 'decompileAndCommit' | 'updateManifest' | 'restoreFromManifest' | 'getWhatRestoreDestroys' | 'changeBuildConfiguration'>;

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
  toolbox: ToolboxView;
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
    toolbox: own(createToolboxView({ instance: undefined })),
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
  instance?: Instance;
  side: (own: Own, deps: ViewsDeps) => InstanceSide;
}

function openInstance(outputChannel: vscode.LogOutputChannel, own: Own): Opened {
  return whenOpened<Opened>(openedFolder(isMo2Instance, (line) => outputChannel.info(line)), {
    instance: (instanceRoot) => {
      const adapter = mo2InstanceAdapter({
        instanceRoot, gameFolderSetting, archives: downloadedFileReader,
      });
      const instance = own(new Instance({
        adapter, gameFolderSettingId: gameFolderSetting.id, window: vscode.window, log: outputChannel,
      }));
      return { facts: factsOf(instance), instance, side: (own, deps) => buildInstanceSide(own, { instanceRoot, adapter, instance }, deps) };
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
  ownAll(own, registerSyncCommands((command, handler) => vscode.commands.registerCommand(command, handler), { modSync, pluginSync }));
  const sourceGestureRows = selectionInFocusedView(
    own, deps.focusedView, [MODS_KEY_ARGS.view, PLUGINS_KEY_ARGS.view], 'modbench.mod.sourceGestureRowsIn');
  const plugins = own(pluginsBox.onInstance({
    instance, commands: pluginCommands({ adapter, client }), pluginSync,
  }));
  const fomodWarning = warnIfFomod(reporterFor('install'));
  const { view: downloadsView, nameFilter: downloadsFilter } = own(createDownloadsView({
    commands: downloadedFileCommands(adapter), instance, reporter: reporterFor('downloadList'), ask, trash,
    log: (line) => outputChannel.warn(`[downloads] ${line}`),
    logUnresolved: (line) => outputChannel.warn(`[instance] ${line}`),
  }));
  const toolbox = own(createToolboxView({ instance, channel: outputChannel }));
  const modlist = modlistRepositoryCommands({ client, adapter, instanceRoot, makeRepository: () => initRepositoryIn(instanceRoot), trash });
  const readStatus: ReadModStatus = (names) => modlist.modStatus(names);
  const mods = own(createModsView({
    instance, commands: modCommands(adapter, client, readStatus), copyReads: adapter, log: (line) => outputChannel.warn(`[modList] ${line}`), modSync, reporterFor, ask, trash,
    extensionUri: deps.extensionUri, warnIfFomod: fomodWarning,
    downloadInstall: {
      reporter: reporterFor('downloadList'), log: (line) => outputChannel.warn(`[downloads] ${line}`),
      progressViewId: DOWNLOADS_KEY_ARGS.view,
    },
    nexusRow: nexusRowInFocusedView(own, deps.focusedView, [MODS_KEY_ARGS.view, DOWNLOADS_KEY_ARGS.view], 'modbench.mod.nexusRowIn'),
    sourceGestures: {
      commands: sourceCommands({ client, adapter, saveUnsaved: saveUnsavedPluginSource }), rows: sourceGestureRows, pluginsView: PLUGINS_KEY_ARGS.view, say: plugins.say,
      registerRepositories: deps.registerRepositories,
    },
    manifestGestures: { commands: modlist, toolboxView: TOOLBOX_VIEW, say: toolbox.say, focusedView: deps.focusedView },
    modStatus: { push: client, readStatus },
  }));
  const editing = own(editingFlow({
    client, instanceRoot, ...plugins.editingInPluginsView, log: (line) => outputChannel.error(line),
  }));
  void editing.enter(instance.landed());
  void client.start();
  const putLoadOrder = loadOrderPutHandler(editing, stringsLanguage);
  own(loadOrderPutOnEachValue(instance, putLoadOrder));
  own(loadOrderPutOnEachLanguageChange(onStringsLanguageChange, instance, putLoadOrder));
  own(vscode.commands.registerCommand('modbench.instance.putLoadOrder', putLoadOrder));
  ownAll(own, registerToolboxCommands({ commands, instance, extensionId, reporterFor }));
  own(publishRepository(instance, instanceRoot));
  ownAll(own, registerModlistCommands({ commands: modlist, instance, reporter: reporterFor('modlist') }));
  own(deps.focusedView.follow(MODS_KEY_ARGS.view, mods.view));
  own(deps.focusedView.follow(PLUGINS_KEY_ARGS.view, plugins.followed));
  own(deps.focusedView.follow(DOWNLOADS_KEY_ARGS.view, downloadsView));
  ownAll(own, registerNameFilterCommands(
    () => deps.focusedView.id(),
    new Map([
      [MODS_KEY_ARGS.view, mods.nameFilter], [PLUGINS_KEY_ARGS.view, plugins.nameFilter], [DOWNLOADS_KEY_ARGS.view, downloadsFilter],
    ]),
  ));
  own(registerRefreshCommand({
    commands, nextRefill: plugins.nextRefill, instance, reporter: reporterFor('refresh'), instanceRoot,
  }));
  return {
    instance, toolbox, readStatus,
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

  own(registerCopyValueCommand(
    [
      ...side.copyValue,
      { text: downloadsCopyValueText(side.downloadsSelection), reporterTag: 'downloadedFile.copyValue' },
      ...deps.editor.copyValue,
    ],
    reporterFor,
    () => deps.focusedView.id(),
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
    loadOrderComing: loadOrderComing(
      opened.instance, meditClient),
    reporterFor,
    ask: askQuestion,
    focusedView,
    recordViewIds: [PLUGINS_KEY_ARGS.view],
    recordWriteProgressView: PLUGINS_KEY_ARGS.view,
    instance: opened.facts,
    sourceEditing,
    modFacts: opened.facts,
    locateRecord: formKeyLocation(meditClient),
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
    reachMEditFromTerminals(context.environmentVariableCollection, meditClient, vscode.Uri.joinPath(context.extensionUri, 'scripts').fsPath),
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

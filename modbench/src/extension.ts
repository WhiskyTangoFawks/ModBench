// The composition root (target-architecture.d2, Activation): builds every box and registers it
// with VS Code, and decides nothing: eslint.config.mjs holds that.

import * as vscode from 'vscode';
import { createMEditClient, stopMEditClient, type MEditClient } from './client';
import { makeReporter } from './drivingLib/reporter';
import { askQuestion } from './dialog';
import { moveToTrash } from './trash';
import { selectionInFocusedView, nexusRowInFocusedView } from './drivingLib/inFocusedView';
import { highlightFollowingFocus } from './drivingLib/highlightFollowsFocus';
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
import { downloadedFileReader, type InstanceAdapter } from './instanceAdapter/instanceAdapter';
import { adapterForInstance, isInstance } from './instanceAdapter/openInstance';
import { serveAgent } from './agent/agentServer';
import { offerToVsCodeChat } from './agent/vsCodeChat';
import { agentPort } from './agent/agentPort';
import { attachPort, deploymentFolderSetting, gameFolderSetting, onStringsLanguageChange, stringsLanguage } from './workspaceConfig';
import { createPlugins, PLUGINS_KEY_ARGS, type Plugins } from './plugins';
import { MODS_KEY_ARGS } from './mods/gestureEntry';
import { createModsView } from './mods/modsView';
import { fileProblemsOver } from './ports/fileProblems';
import { problemsHostOver } from './problemsHost';
import { ModStatuses } from './modStatus/modStatuses';
import type { DownloadsTreeNode } from './downloads/DownloadsProvider';
import { DOWNLOADS_KEY_ARGS, downloadsCopyValueText } from './downloads/keyContext';
import { createDownloadsView } from './downloads/downloadsView';
import { createToolboxView, type ToolboxView } from './toolbox/toolboxView';
import type { PluginsTxtPlaceOf } from './toolbox/ToolboxProvider';
import { gameReleaseForGame } from './tables/gamePaths';
import { hostGit } from './hostGit';
import { hostTasks } from './tasks';
import { stepTasks } from './sourceCommands/steps';
import { registerModlistCommands } from './toolbox/modlistGestures';
import { publishRepository } from './toolbox/repositoryContext';
import { queryInfoOver } from './downloadedFileCommands/queryInfo';
import { checkForUpdatesOver } from './modCommands/checkForUpdates';
import { createHttpNexus } from './nexus/httpNexus';
import type { Nexus } from './nexus/nexus';
import { registerNexusCommands } from './toolbox/nexusCommands';
import { nexusLogin } from './instanceCommands/nexusLogin';
import { registerRefreshCommand, registerToolboxCommands, TOOLBOX_VIEW } from './toolbox/toolboxCommands';
import { afterTrust, openedFolder, whenOpened } from './toolbox/instanceCheck';
import { markFirstReadLanded } from './drivingLib/instanceFirstRead';
import { toastOncePerFailure } from './drivingLib/toastOncePerFailure';
import { reportSubscriberThrows } from './drivingLib/reportSubscriberThrows';
import { pluginCommands, pluginSyncOver } from './pluginCommands/plugins';
import { modlistRepositoryCommands } from './sourceCommands/modlistRepositoryCommands';
import { newRepositoriesOver } from './sourceCommands/newRepository';
import { sourceCommands } from './sourceCommands/sourceCommands';
import { modSyncOver, modCommands } from './modCommands/modCommands';
import { downloadedFileCommands } from './downloadedFileCommands/downloads';
import { editingFlow } from './instanceCommands/editing';
import { instanceCommands } from './instanceCommands/instanceCommands';
import { deployCommands } from './instanceCommands/deploy';
import { deployedPath, hardlinkDeployment } from './deployment/deployment';
import { pluginsTxtPlace } from './deployment/pluginsTxtPlace';
import { registerDeployCommands } from './toolbox/deployGesture';
import { present } from './ports/present';
import { reachMEditFromEnvFile } from './agent/scriptEnvironmentFile';
import { reachMEditFromTerminals } from './agent/terminalEnvironment';
import { instanceSyncs, registerSyncCommands, loadOrderPutHandler, loadOrderPutOnEachLanguageChange, loadOrderPutOnEachValue } from './syncWiring';
import type { Reporter } from './ports/reporter';
import type { AskQuestion } from './ports/dialog';
import type { MoveToTrash } from './ports/trash';

// Records a disposable against its owner's teardown and hands it back. `src/test/disposableOwnershipScan.test.ts`
// fails on a registration that skips it.
type Own = <T extends vscode.Disposable>(disposable: T) => T;

type ViewsClient = Pick<MEditClient,
  'sendLoadOrder' | 'onLoadOrderResent' | 'latestLoadOrder' | 'onLaunch' | 'onExit' | 'start' | 'rebuildIndex'
  | 'onNotification' | 'getPlugins' | 'getRenameSourceChanges' | 'moveLastWritten' | 'repairPreviews' | 'decompileAndRepair' | 'getPluginDependants' | 'getCreatablePluginExtensions' | 'build' | 'decompileAndCommit' | 'cloneSubmodules' | 'loadOrderStatus' | 'onLoadOrderStatus' | 'getPluginIndexing'>;

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
  /** The workspace's own storage, which an opened folder always has. */
  storage: vscode.Uri | undefined;
  nexus: Nexus;
  focusedView: FocusedView;
  editor: Pick<Editor, 'copyValue'>;
}

interface InstanceSide {
  /** Absent together, on the path with no instance to read. */
  instance?: Instance;
  statuses?: ModStatuses;
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
  scriptEnvironmentFile?: InstanceAdapter['scriptEnvironmentFile'];
  side: (own: Own, deps: ViewsDeps) => InstanceSide;
}

// esbuild writes the engine's process and copies its add-on beside the extension. The engine answers a step in
// milliseconds, so a minute of silence is an engine that hangs.
const fomodEngineIn = (extensionUri: vscode.Uri) => ({
  process: vscode.Uri.joinPath(extensionUri, 'out', 'fomodEngine.js').fsPath,
  folder: vscode.Uri.joinPath(extensionUri, 'out', 'fomodEngine').fsPath,
  silence: 60_000,
});

function openFolderAsInstance(outputChannel: vscode.LogOutputChannel, own: Own, extensionUri: vscode.Uri): Opened {
  return whenOpened<Opened>(openedFolder(isInstance, (line) => outputChannel.info(line)), {
    instance: (instanceRoot) => {
      const adapter = adapterForInstance({
        instanceRoot, gameFolderSetting, scriptEnvironmentFileSetting: () => vscode.workspace.getConfiguration('python', vscode.Uri.file(instanceRoot)).get<string>('envFile'), installationFileReader: downloadedFileReader, fileProblems: fileProblemsOver(problemsHostOver(own(vscode.languages.createDiagnosticCollection('modbench-unhashed'))), outputChannel), fomodEngine: fomodEngineIn(extensionUri), deployedPath,
      });
      const instance = own(new Instance({
        adapter, gameFolderSettingId: gameFolderSetting.id, window: vscode.window, log: outputChannel,
      }));
      return { facts: factsOf(instance), instance, scriptEnvironmentFile: adapter.scriptEnvironmentFile, side: (own, deps) => buildInstanceSide(own, { instanceRoot, adapter, instance }, deps) };
    },
    notAnInstance: () => ({ facts: NO_INSTANCE_FACTS, side: buildBareSide }),
  });
}

function buildInstanceSide(own: Own, { instanceRoot, adapter, instance }: OpenedInstance, deps: ViewsDeps): InstanceSide {
  const { outputChannel, client, plugins: pluginsBox, reporterFor, ask, trash, extensionId } = deps;
  own(markFirstReadLanded(instance));
  own(reportSubscriberThrows(instance, toastOncePerFailure(reporterFor('instance'))));
  const commands = instanceCommands({ adapter, client, instanceRoot });
  const modlist = modlistRepositoryCommands({ client, adapter, nexus: deps.nexus, instanceRoot, hostGit, trash, tasks: stepTasks(hostTasks), pathProblems: fileProblemsOver(problemsHostOver(own(vscode.languages.createDiagnosticCollection('modbench-paths'))), outputChannel) });
  const modStatuses = own(new ModStatuses(adapter, (line) => outputChannel.warn(`[modList] ${line}`)));
  own(instance.subscribe((value) => { modStatuses.derive(value); }));
  const { modSync, pluginSync } = own(instanceSyncs({
    instance, syncMods: modSyncOver(adapter), channel: outputChannel, syncPlugins: pluginSyncOver(adapter),
  }));
  ownAll(own, registerSyncCommands((command, handler) => vscode.commands.registerCommand(command, handler), { modSync, pluginSync }));
  const sourceGestureRows = selectionInFocusedView(
    own, deps.focusedView, [MODS_KEY_ARGS.view, PLUGINS_KEY_ARGS.view], 'modbench.mod.sourceGestureRowsIn');
  const plugins = own(pluginsBox.onInstance({
    instance, commands: pluginCommands({ adapter, client, newRepositories: newRepositoriesOver(adapter) }), pluginSync, modStatuses,
  }));
  const { view: downloadsView, nameFilter: downloadsFilter } = own(createDownloadsView({
    commands: downloadedFileCommands(adapter), queryInfo: queryInfoOver(adapter, deps.nexus), instance, reporter: reporterFor('downloadedFiles'), ask, trash,
    log: (line) => outputChannel.warn(`[downloadedFiles] ${line}`),
    logUnresolved: (line) => outputChannel.warn(`[instance] ${line}`),
  }));
  const placeOfPluginsTxt = pluginsTxtPlace(process.platform, process.env, (folder) => adapter.nonSteamPrefix(folder));
  const placeForGame: PluginsTxtPlaceOf = (gameName, folder) => placeOfPluginsTxt(gameReleaseForGame(gameName), folder);
  const toolbox = own(createToolboxView({ instance, channel: outputChannel, deploymentFolder: deploymentFolderSetting, pluginsTxtPlace: placeForGame }));
  const mods = own(createModsView({
    instance, commands: modCommands(adapter), copyReads: adapter, log: (line) => outputChannel.warn(`[modList] ${line}`), modSync, reporterFor, ask, trash,
    extensionUri: deps.extensionUri,
    downloadedFileInstallReporting: {
      reporter: reporterFor('downloadedFiles'), log: (line) => outputChannel.warn(`[downloadedFiles] ${line}`),
      progressViewId: DOWNLOADS_KEY_ARGS.view,
    },
    nexusRow: nexusRowInFocusedView(own, deps.focusedView, [MODS_KEY_ARGS.view, DOWNLOADS_KEY_ARGS.view], 'modbench.mod.nexusRowIn'),
    sourceGestures: {
      commands: sourceCommands({ client, adapter, saveUnsaved: saveUnsavedPluginSource, tasks: stepTasks(hostTasks) }), rows: sourceGestureRows, pluginsView: PLUGINS_KEY_ARGS.view, say: plugins.say,
      registerRepositories: deps.registerRepositories,
    },
    checkForUpdates: checkForUpdatesOver(adapter, deps.nexus),
    manifestGestures: { commands: modlist, toolboxView: TOOLBOX_VIEW, say: toolbox.say, focusedView: deps.focusedView },
    statuses: modStatuses,
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
  ownAll(own, registerNexusCommands({ commands: nexusLogin(deps.nexus), nexus: deps.nexus, reporter: reporterFor('nexus') }));
  own(publishRepository(instance, instanceRoot));
  ownAll(own, registerModlistCommands({ commands: modlist, instance, reporter: reporterFor('modlist') }));
  own(deps.focusedView.follow(MODS_KEY_ARGS.view, mods.view));
  own(deps.focusedView.follow(PLUGINS_KEY_ARGS.view, plugins.followed));
  own(deps.focusedView.follow(DOWNLOADS_KEY_ARGS.view, downloadsView));
  own(highlightFollowingFocus(
    deps.focusedView, new Map([[MODS_KEY_ARGS.view, mods.relatesRows], [PLUGINS_KEY_ARGS.view, plugins.relatesRows]]),
    [plugins.drawsHighlight, mods.drawsHighlight], (listener) => instance.subscribe(listener)));
  ownAll(own, registerNameFilterCommands(
    () => deps.focusedView.id(),
    new Map([
      [MODS_KEY_ARGS.view, mods.nameFilter], [PLUGINS_KEY_ARGS.view, plugins.nameFilter], [DOWNLOADS_KEY_ARGS.view, downloadsFilter],
    ]),
  ));
  own(registerRefreshCommand({
    commands, nextRefill: plugins.nextRefill, instance, reporter: reporterFor('refresh'), instanceRoot,
  }));
  ownAll(own, registerDeployCommands({
    commands: deployCommands({
      adapter,
      deployment: hardlinkDeployment(present(deps.storage, 'the storage of the workspace an instance opens in').fsPath, placeOfPluginsTxt),
      deploymentFolder: deploymentFolderSetting,
    }),
    instance, reporter: reporterFor('deploy'),
  }));
  return {
    instance, toolbox, statuses: modStatuses,
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
  context.subscriptions.push(afterTrust(isInstance, () => { start(context); }));
}

function start(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel('Modbench', { log: true });
  context.subscriptions.push(outputChannel);

  // ADR-0002.
  const meditClient = createMEditClient({ backend: { attachPort: attachPort() }, backendLog: outputChannel, log: outputChannel, listenerThrows: toastOncePerFailure(makeReporter(outputChannel, 'notifications')) });
  const focusedView = createFocusedView();

  const ownedByViews = ownership();
  const opened = openFolderAsInstance(outputChannel, ownedByViews.own, context.extensionUri);
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
    storage: context.storageUri,
    nexus: createHttpNexus(context.secrets, context.extension.packageJSON),
    focusedView,
    editor,
  });
  const scriptEnvironmentFailures = toastOncePerFailure(reporterFor('scriptEnvironment'));
  const scriptsPath = vscode.Uri.joinPath(context.extensionUri, 'scripts').fsPath;
  const agentServer = serveAgent({ port: agentPort(), instance: views.instance, statuses: views.statuses, mEdit: meditClient, terminalEnvironment: context.environmentVariableCollection, reporter: reporterFor('agent'), log: outputChannel });
  context.subscriptions.push(
    views,
    plugins,
    editor,
    agentServer,
    offerToVsCodeChat(agentServer),
    reachMEditFromTerminals(context.environmentVariableCollection, meditClient, scriptsPath),
    reachMEditFromEnvFile({
      client: meditClient, scriptsPath, envFile: opened.scriptEnvironmentFile,
      fail: (message, detail) => { scriptEnvironmentFailures.threw(scriptEnvironmentFailures, message, detail); },
    }),
    createSourceLanguage({
      client: meditClient, sourceFiles: (origin) => views.sourceFiles(origin), reporter: makeReporter(outputChannel, 'sourceLanguage'),
    }),
  );
}

// Async so VS Code awaits confirmed-dead-child teardown before the extension host finishes
// tearing down — otherwise a reload's replacement client is structurally unable to ever clean up
// this instance's spawned child.
export async function deactivate(): Promise<void> {
  await stopMEditClient();
}

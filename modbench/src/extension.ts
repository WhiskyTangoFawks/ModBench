// The composition root (target-architecture.d2, Activation): builds every box and registers it
// with VS Code, and decides nothing: eslint.config.mjs holds that.

import * as vscode from 'vscode';
import { attachPortOf, createMEditClient, pluginSourceNames, recordIndexReferences, scriptSourceRename, stopMEditClient, type MEditClient, type PluginFilePaths, type PluginProblems } from './client';
import { manifestFileReferences, manifestEntryNames } from './manifestAdapter/manifestAdapter';
import type { EntryNames, SymbolOwner } from './symbolNames/symbolNames';
import { makeReporter } from './drivingLib/reporter';
import { workspaceFolders } from './toolbox/workspaceFolders';
import { commandTitles } from './drivingLib/commandTitles';
import { surfaceManagerRunning, surfaceReadModel, surfaceRefusedWrites, type ManagerState } from './drivingLib/writingGesture';
import { askQuestion } from './dialog';
import { moveToTrash } from './trash';
import { ambientWrites } from './instanceLoader/ambientWrites';
import { leaveWritesUnnamed, diskCheckedBy, writesToldTo } from './repositoriesLib/writesTold';
import { highlightFollowingFocus } from './drivingLib/highlightFollowsFocus';
import { createFocusedView, type FocusedView } from './drivingLib/focusedView';
import { createEditor, loadOrderComing, sourceModRepositoriesOver } from './editor';
import { quickFixes } from './drivingLib/quickFixes';
import type { FileCopies } from './symbols/fileLanguage';
import type { Reveal } from './drivingLib/symbolRows';
import { createSymbols, followRenames, referencedByCopyValue, registerFollowRename, type SymbolRows } from './symbols';
import { createSourceLanguage } from './sourceLanguage';
import { problemsAsker } from './drivingLib/problemsAsker';
import { savedText } from './textDocuments/fileText';
import { saveUnsavedUnder } from './textDocuments/saveUnsavedUnder';
import { registerFilterCommands as registerNameFilterCommands } from './drivingLib/nameFilter';
import { registerCopyValueCommand, type CopyValueAdapter } from './drivingLib/copyValue';
import type { SourceEditing } from './textDocuments/sourceEditing';
import { applyWorkspaceChanges } from './textDocuments/applyWorkspaceChanges';
import { oneAtATime } from './textDocuments/oneAtATime';
import { Instance, managerRunningMessage } from './instanceLoader/instance';
import { factsOf, NO_INSTANCE_FACTS, type InstanceFacts } from './instanceLoader/instanceFacts';
import { sourceFiles, NO_SOURCE_FILES, type SourceFilesOf } from './instanceLoader/loadOrderSnapshot';
import { downloadedFileReader, isPluginSourcePath, type InstanceAdapter, type EntryRef } from './instanceAdapter/instanceAdapter';
import type { CopyReads } from './mods/sameCopies';
import { adapterForInstance, isInstance } from './instanceAdapter/openInstance';
import { serveAgent } from './agent/agentServer';
import type { DeploymentRead } from './agent/instanceReads';
import type { PluginsShown } from './drivingLib/pluginsShown';
import { deploymentFolderOf } from './instanceCommands/deploy';
import { offerToVsCodeChat } from './agent/vsCodeChat';
import { agentPort } from './agent/agentPort';
import { deploymentFolderSetting, gameFolderSetting } from './toolbox/workspaceSettings';
import { watcherExcludeSetting } from './watcherExcludeSetting';
import { registerPutLoadOrder } from './toolbox/putLoadOrderCommand';
import { showProgressWhileLate } from './drivingLib/lateProgress';
import { reportUnwatchedFolders } from './drivingLib/unwatchedFolders';
import { createPlugins, PLUGINS_KEY_ARGS, type Plugins } from './plugins';
import { MODS_KEY_ARGS } from './mods/gestureEntry';
import { createModsView } from './mods/modsView';
import { copyTheGameGets, revealCopy } from './mods/fileCopy';
import { NO_PATH_STANDING, pathStandingOf } from './mods/pathStanding';
import type { PathStanding } from './sourceLanguage/pathProblems';
import { registerArchiveFiles, registerArchiveOpen } from './mods/archiveFiles';
import { fileProblemsOver } from './ports/fileProblems';
import type { Log } from './ports/log';
import { problemsHostOver } from './problemsHost';
import { ModStatuses } from './modStatus/modStatuses';
import { DOWNLOADS_KEY_ARGS } from './downloads/keyContext';
import { createDownloadsView } from './downloads/downloadsView';
import { createToolboxView, type ToolboxView } from './toolbox/toolboxView';
import type { PluginsTxtPlaceOf } from './toolbox/ToolboxProvider';
import { gameReleaseForGame, pluginCompanionRule } from './tables/gamePaths';
import { hostGit } from './hostGit';
import { hostTasks, scriptHostIn } from './tasks';
import { stepTasks } from './sourceCommands/steps';
import { registerModlistCommands } from './toolbox/modlistGestures';
import { publishRepository } from './toolbox/repositoryContext';
import { downloadOver } from './downloadedFileCommands/download';
import { queryInfoOver } from './downloadedFileCommands/queryInfo';
import { checkForUpdatesOver } from './modCommands/checkForUpdates';
import { createHttpNexus } from './nexus/httpNexus';
import type { Nexus } from './nexus/nexus';
import { registerNexusCommands } from './toolbox/nexusCommands';
import { nexusLogin } from './instanceCommands/nexusLogin';
import { masterlistCommands } from './instanceCommands/masterlist';
import { registerMasterlistCommand } from './toolbox/masterlistGesture';
import { createHttpLootMetadata } from './lootMetadata/httpLootMetadata';
import type { LootMetadata } from './lootMetadata/lootMetadata';
import { registerRebuildRecordIndexCommand, registerRefreshCommand, registerToolboxCommands, TOOLBOX_VIEW } from './toolbox/toolboxCommands';
import { afterTrust, openedFolder, whenOpened } from './toolbox/instanceCheck';
import { markFirstReadLanded } from './drivingLib/instanceFirstRead';
import { toastOncePerFailure } from './drivingLib/toastOncePerFailure';
import { reportSubscriberThrows } from './drivingLib/reportSubscriberThrows';
import { askedOnceLoadOrderPut, fileReadsOver, pluginCommands, pluginSyncOver } from './pluginCommands/plugins';
import { instanceRepositoryCommands } from './sourceCommands/instanceRepositoryCommands';
import { placeModsOver } from './sourceCommands/newRepository';
import { sourceCommands } from './sourceCommands/sourceCommands';
import { modSyncOver, modCommands } from './modCommands/modCommands';
import { entryRenameCommands } from './modCommands/renameEntry';
import { scriptRenameCommands } from './modCommands/renameScript';
import { downloadedFileCommands } from './downloadedFileCommands/downloads';
import { editingFlow } from './instanceCommands/editing';
import { instanceCommands } from './instanceCommands/instanceCommands';
import { deployCommands } from './instanceCommands/deploy';
import { deployedPath, hardlinkDeployment } from './deployment/deployment';
import { pluginsTxtPlace } from './deployment/pluginsTxtPlace';
import { registerDeployCommands } from './toolbox/deployGesture';
import { present } from './ports/present';
import { scriptEnvironmentFileOf } from './agent/pythonEnvFile';
import { reachMEditFromEnvFile } from './agent/scriptEnvironmentFile';
import { reachMEditFromTerminals } from './agent/terminalEnvironment';
import { modSyncOn, registerModSyncCommand } from './mods/modSync';
import type { Reporter } from './ports/reporter';
import type { AskQuestion } from './ports/dialog';
import type { MoveToTrash } from './ports/trash';

// Records a disposable against its owner's teardown and hands it back. `src/test/disposableOwnershipScan.test.ts`
// fails on a registration that skips it.
type Own = <T extends vscode.Disposable>(disposable: T) => T;

type ViewsClient = Pick<MEditClient,
  'sendLoadOrder' | 'latestLoadOrder' | 'loadOrderApplied' | 'signalChange' | 'onLaunch' | 'onExit' | 'start' | 'rebuildIndex'
  | 'getPlugins' | 'getRenameSourceChanges' | 'getPluginNameReferences' | 'getScriptReferences' | 'getFileReferences' | 'getPluginSourceNames' | 'getScriptRenameSourceChanges' | 'getCopyDocument' | 'getRecordOwners' | 'moveLastWritten' | 'getSourceFolderMoveChanges' | 'followSourceFolderMove' | 'decompileAndRepair' | 'getCreatablePluginExtensions' | 'getCreatablePluginFlags' | 'build' | 'versionInGit' | 'cloneSubmodules' | 'setPluginFileFlags' | 'getFlaggedPluginHashes' | 'recordIndexProgress' | 'status' | 'onDidChange' | 'getPluginIndexing' | 'getArchiveCopies'>;

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
  lootMetadata: LootMetadata;
  focusedView: FocusedView;
  copyValue: readonly CopyValueAdapter[];
  sourceEditing: SourceEditing;
}

interface InstanceSide {
  /** Absent together, on the path with no instance to read. */
  instance?: Instance;
  statuses?: ModStatuses;
  deployment?: DeploymentRead;
  copyReads?: CopyReads;
  pluginsShown?: PluginsShown;
  symbolRows?: SymbolRows;
  toolbox: ToolboxView;
  modsLines: () => string[];
  entryTooltip: (entry: EntryRef) => string | undefined;
  downloadedFileTooltip: (name: string) => string | undefined;
  downloadedFileRow: (name: string) => Reveal | undefined;
  modOrderFileOf: (profile: string) => string | undefined;
  fileCopies: FileCopies;
  pathStanding: PathStanding;
  sourceFiles: SourceFilesOf;
  copyValue: CopyValueAdapter[];
}

type Views = InstanceSide & vscode.Disposable;

const ownAll = (own: Own, disposables: vscode.Disposable[]): void => {
  own(vscode.Disposable.from(...disposables));
};

function buildBareSide(own: Own): InstanceSide {
  return {
    toolbox: own(createToolboxView({ instance: undefined })),
    modsLines: () => [],
    entryTooltip: () => undefined,
    downloadedFileTooltip: () => undefined,
    downloadedFileRow: () => undefined,
    modOrderFileOf: () => undefined,
    fileCopies: { copyOf: (path) => ({ none: `No instance is open to hold ${path}.` }), reveal: revealCopy },
    pathStanding: NO_PATH_STANDING,
    sourceFiles: NO_SOURCE_FILES,
    copyValue: [],
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
  managerRunning: Pick<Parameters<typeof surfaceManagerRunning>[0], 'running' | 'message'>;
  scriptEnvironmentFile?: InstanceAdapter['scriptEnvironmentFile'];
  /** Each box over the instance's files that says where they name a symbol. */
  owners: readonly SymbolOwner[];
  /** Each box over the instance's files that says where they name a symbol its name alone names. */
  entryOwners: readonly EntryNames[];
  side: (own: Own, deps: ViewsDeps) => InstanceSide;
}

// esbuild writes the engine's process and copies its add-on beside the extension. The engine answers a step in
// milliseconds, so a minute of silence is an engine that hangs.
const fomodEngineIn = (extensionUri: vscode.Uri, log: Log) => ({
  process: vscode.Uri.joinPath(extensionUri, 'out', 'fomodEngine.js').fsPath,
  folder: vscode.Uri.joinPath(extensionUri, 'out', 'fomodEngine').fsPath,
  silence: 60_000,
  log,
});

function openFolderAsInstance(outputChannel: vscode.LogOutputChannel, own: Own, extensionUri: vscode.Uri, medit: MEditClient): Opened {
  return whenOpened<Opened>(openedFolder(isInstance, (line) => outputChannel.info(line)), {
    instance: (instanceRoot) => {
      const adapter = adapterForInstance({
        instanceRoot, gameFolderSetting, watcherExclude: watcherExcludeSetting, hostGit, scriptEnvironmentFileSetting: scriptEnvironmentFileOf(instanceRoot), installationFileReader: downloadedFileReader, fileProblems: fileProblemsOver(problemsHostOver(own(vscode.languages.createDiagnosticCollection('modbench-unhashed'))), outputChannel), fomodEngine: fomodEngineIn(extensionUri, outputChannel), deployedPath,
      });
      const instance = own(new Instance({
        adapter, gameFolderSettingId: gameFolderSetting.id, log: outputChannel, medit, workspace: workspaceFolders,
      }));
      writesToldTo(instance);
      const owners = [adapter.pluginReferences, manifestFileReferences({
        sourceFolders: () => instance.value.paths.sourceDirs,
        modFolderOf: (mod) => adapter.modFolderPath(mod),
        companions: async () => pluginCompanionRule(await adapter.gameRelease()),
      })];
      const entryOwners = [adapter.entryReferences, manifestEntryNames({ modFolderOf: (mod) => adapter.modFolderPath(mod), modFolders: () => instance.value.paths.modDirs })];
      const managerRunning = {
        running: () => adapter.managerRunning(),
        message: (state: ManagerState) => managerRunningMessage({ managerRunning: state, managerNames: instance.value.managerNames }),
      };
      return { facts: factsOf(instance), instance, managerRunning, scriptEnvironmentFile: adapter.scriptEnvironmentFile, owners, entryOwners, side: (own, deps) => buildInstanceSide(own, { instanceRoot, adapter, instance }, deps) };
    },
    notAnInstance: () => ({ facts: NO_INSTANCE_FACTS, managerRunning: { running: () => Promise.resolve({ kind: 'notRunning' }), message: () => undefined }, owners: [], entryOwners: [], side: buildBareSide }),
  });
}

function buildInstanceSide(own: Own, { instanceRoot, adapter, instance }: OpenedInstance, deps: ViewsDeps): InstanceSide {
  const { outputChannel, client, plugins: pluginsBox, reporterFor, ask, trash, extensionId } = deps;
  own(markFirstReadLanded(instance));
  own(reportSubscriberThrows(instance, reporterFor));
  own(reportUnwatchedFolders(instance, reporterFor('instance')));
  own(showProgressWhileLate(instance, [TOOLBOX_VIEW, MODS_KEY_ARGS.view, PLUGINS_KEY_ARGS.view, DOWNLOADS_KEY_ARGS.view]));
  const commands = instanceCommands({ adapter, client, instanceRoot });
  const tasks = stepTasks(hostTasks, scriptHostIn(deps.extensionUri));
  const instanceRepository = instanceRepositoryCommands({ client, adapter, nexus: deps.nexus, instanceRoot, hostGit, trash, tasks, loadOrderSnapshot: () => instance.value.loadOrderSnapshot });
  const modStatuses = own(new ModStatuses(adapter, (line) => outputChannel.warn(line)));
  own(instance.subscribe(async (value) => {
    modStatuses.derive(value);
    await modStatuses.current();
  }));
  const { modSync } = own(modSyncOn({ instance, syncMods: modSyncOver(adapter), channel: outputChannel }));
  own(registerModSyncCommand(modSync));
  const commandsOfPlugins = pluginCommands({ adapter, client, placeMods: placeModsOver(adapter) });
  const entryRenames = entryRenameCommands({ adapter, client });
  own(registerFollowRename(followRenames({
    adapter, plugins: commandsOfPlugins, entries: entryRenames, downloads: downloadedFileCommands(adapter), profiles: commands, source: deps.sourceEditing, instance,
    scripts: scriptRenameCommands({ adapter, client, references: scriptSourceRename({ client, refreshSourceControlFor: deps.sourceEditing.refreshSourceControlFor }) }),
    reporter: reporterFor('symbol.followRename'),
  })));
  const plugins = own(pluginsBox.onInstance({
    instance, commands: commandsOfPlugins, syncPlugins: pluginSyncOver(adapter, askedOnceLoadOrderPut(client)), modStatuses,
    fileReads: fileReadsOver(adapter, () => instance.value.files),
  }));
  const downloads = own(createDownloadsView({
    commands: downloadedFileCommands(adapter), queryInfo: queryInfoOver(adapter, deps.nexus), download: downloadOver(adapter, deps.nexus), instance, reporterFor, trash, channel: outputChannel,
  }));
  const placeOfPluginsTxt = pluginsTxtPlace(process.platform, process.env, (folder) => adapter.nonSteamPrefix(folder));
  const placeForGame: PluginsTxtPlaceOf = (gameName, folder) => placeOfPluginsTxt(gameReleaseForGame(gameName), folder);
  const toolbox = own(createToolboxView({ instance, channel: outputChannel, deploymentFolder: deploymentFolderSetting, pluginsTxtPlace: placeForGame }));
  const mods = own(createModsView({
    instance, commands: modCommands(adapter), renames: entryRenames, source: deps.sourceEditing, copyReads: adapter, channel: outputChannel, modSync, reporterFor, ask, trash,
    extensionUri: deps.extensionUri,
    downloadsView: DOWNLOADS_KEY_ARGS.view, focusedView: deps.focusedView,
    sourceGestures: {
      commands: sourceCommands({ client, adapter, saveUnsaved: saveUnsavedUnder, loadOrderSnapshot: () => instance.value.loadOrderSnapshot, tasks, trash }), pluginsView: PLUGINS_KEY_ARGS.view, say: plugins.say,
      registerRepositories: deps.registerRepositories,
    },
    checkForUpdates: checkForUpdatesOver(adapter, deps.nexus),
    manifestGestures: { commands: instanceRepository, toolboxView: TOOLBOX_VIEW, say: toolbox.say },
    statuses: modStatuses,
    archives: client,
  }));
  own(registerArchiveOpen({ gameRelease: () => adapter.gameRelease(), reporter: reporterFor('archive.open') }));
  const editing = own(editingFlow({
    client, instanceRoot, ...plugins.editingInPluginsView, log: (line) => outputChannel.error(line),
  }));
  void editing.enter(instance.landed());
  void client.start();
  own(registerPutLoadOrder(editing, instance));
  ownAll(own, registerToolboxCommands({ commands, instance, extensionId, reporterFor }));
  ownAll(own, registerNexusCommands({ commands: nexusLogin(deps.nexus), nexus: deps.nexus, reporterFor }));
  own(registerMasterlistCommand({
    commands: masterlistCommands({ adapter, lootMetadata: deps.lootMetadata, trash }), instance, pluginsView: PLUGINS_KEY_ARGS.view, say: plugins.say, reporter: reporterFor('updateMasterlist'),
  }));
  own(publishRepository(instance, instanceRoot));
  ownAll(own, registerModlistCommands({ commands: instanceRepository, instance, reporterFor }));
  own(deps.focusedView.follow(MODS_KEY_ARGS.view, mods.view));
  own(deps.focusedView.follow(PLUGINS_KEY_ARGS.view, plugins.followed));
  own(deps.focusedView.follow(DOWNLOADS_KEY_ARGS.view, downloads.view));
  own(highlightFollowingFocus(
    deps.focusedView, new Map([[MODS_KEY_ARGS.view, mods.relatesRows], [PLUGINS_KEY_ARGS.view, plugins.relatesRows]]),
    [plugins.drawsHighlight, mods.drawsHighlight],
    (listener) => instance.subscribe(listener, { mods: true, modGroups: true, filesByMod: true, overwriteFiles: true, plugins: true, pluginsLoadedWithNoLine: true })));
  ownAll(own, registerNameFilterCommands(
    () => deps.focusedView.id(),
    new Map([
      [MODS_KEY_ARGS.view, mods.nameFilter], [PLUGINS_KEY_ARGS.view, plugins.nameFilter], [DOWNLOADS_KEY_ARGS.view, downloads.nameFilter],
    ]),
  ));
  own(registerRefreshCommand({ instance, recordIndexProgress: () => client.recordIndexProgress, mEditStatus: () => client.status, reporterFor, instanceRoot }));
  own(registerRebuildRecordIndexCommand({
    commands, nextRefill: plugins.nextRefill, instance, reporterFor, instanceRoot,
  }));
  ownAll(own, registerDeployCommands({
    commands: deployCommands({
      adapter,
      deployment: hardlinkDeployment(present(deps.storage, 'the storage of the workspace an instance opens in').fsPath, placeOfPluginsTxt, leaveWritesUnnamed),
      deploymentFolder: deploymentFolderSetting,
    }),
    instance, reporterFor,
  }));
  return {
    instance, toolbox, statuses: modStatuses, pluginsShown: plugins.pluginsShown, copyReads: adapter,
    modsLines: () => mods.standingLines(),
    entryTooltip: (entry) => mods.tooltipOf(entry),
    downloadedFileTooltip: (name) => downloads.tooltipOf(name),
    downloadedFileRow: (name) => downloads.show(name),
    modOrderFileOf: (profile) => adapter.modOrderFileOf(profile),
    fileCopies: { copyOf: (path) => copyTheGameGets(instance.value, path), reveal: revealCopy },
    deployment: { folder: () => deploymentFolderOf(deploymentFolderSetting), pluginsTxtPlace: placeForGame },
    pathStanding: pathStandingOf(instance),
    sourceFiles: (origin) => sourceFiles(instance.value, origin),
    symbolRows: {
      mods: mods.symbolRows, plugins: plugins.symbolRows, filesHeld: () => instance.value,
      selection: () => deps.focusedView.selection(),
    },
    copyValue: [mods.copyValue, plugins.copyValue, downloads.copyValue],
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
      ...deps.copyValue,
    ],
    reporterFor,
    () => deps.focusedView.id(),
  ));

  return {
    ...side,
    dispose,
  };
}

interface SymbolsDeps {
  meditClient: MEditClient;
  asker: Parameters<typeof createSymbols>[0]['asker'];
  outputChannel: vscode.LogOutputChannel;
  reporterFor: (tag: string) => Reporter;
  opened: Opened;
  views: Views;
  focusedRecord: Parameters<typeof createSymbols>[0]['focusedRecord'];
}

function symbolsOver({ meditClient, asker, outputChannel, reporterFor, opened, views, focusedRecord }: SymbolsDeps) {
  const sourceNames = pluginSourceNames(meditClient, isPluginSourcePath);
  return createSymbols({
    client: meditClient, asker, names: sourceNames, instance: views.instance, reporter: makeReporter(outputChannel, 'symbols'), reporterFor, rows: views.symbolRows,
    focusedRecord,
    sourceFiles: (origin) => views.sourceFiles(origin),
    savedText: (path) => savedText(vscode.Uri.file(path)),
    pluginsShown: views.pluginsShown,
    fileCopies: views.fileCopies,
    entryTooltip: views.entryTooltip,
    downloadedFileTooltip: views.downloadedFileTooltip,
    downloadedFileRow: views.downloadedFileRow,
    modOrderFileOf: views.modOrderFileOf,
    owners: [recordIndexReferences(meditClient, () => Promise.resolve([]), sourceNames), ...opened.owners],
    entryOwners: opened.entryOwners,
  });
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(afterTrust(isInstance, () => { start(context); }));
}

function start(context: vscode.ExtensionContext): void {
  diskCheckedBy(ambientWrites);
  const outputChannel = vscode.window.createOutputChannel('Modbench', { log: true });
  context.subscriptions.push(outputChannel);

  // ADR-0002.
  const meditClient = createMEditClient({ backend: { attachPort: attachPortOf((key) => vscode.workspace.getConfiguration('modbench').get(key)) }, backendLog: outputChannel, log: outputChannel, listenerThrows: toastOncePerFailure(makeReporter(outputChannel, 'notifications')), leaveWritesUnnamed });
  context.subscriptions.push(registerArchiveFiles(meditClient));
  const focusedView = createFocusedView();

  const ownedByViews = ownership();
  const opened = openFolderAsInstance(outputChannel, ownedByViews.own, context.extensionUri, meditClient);
  const sourceModRepositories = sourceModRepositoriesOver({ client: meditClient, outputChannel, ...opened.facts });
  const sourceEditing: SourceEditing = {
    applyWorkspaceChanges: (items) => applyWorkspaceChanges(items, { writing: (paths) => ambientWrites.name(paths) }),
    oneAtATime: oneAtATime(),
    refreshSourceControlFor: sourceModRepositories.refreshSourceControlFor,
  };
  const reporterFor = (tag: string) => makeReporter(outputChannel, tag);
  context.subscriptions.push(surfaceRefusedWrites({ reporter: reporterFor('write'), titles: commandTitles(context.extension.packageJSON), redraw: opened.facts.redraw }));
  context.subscriptions.push(surfaceReadModel({ handed: () => meditClient.loadOrdersHanded(), taken: () => meditClient.loadOrderApplied() }));
  context.subscriptions.push(surfaceManagerRunning({ reporter: reporterFor('write'), ...opened.managerRunning }));
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
    lootMetadata: createHttpLootMetadata(),
    focusedView,
    copyValue: [...editor.copyValue, referencedByCopyValue],
    sourceEditing,
  });
  const scriptEnvironmentFailures = toastOncePerFailure(reporterFor('scriptEnvironment'));
  const scriptsPath = vscode.Uri.joinPath(context.extensionUri, 'scripts').fsPath;
  const asker = problemsAsker<PluginFilePaths, PluginProblems>(meditClient);
  const sourceLanguage = createSourceLanguage({
    client: meditClient, ask: asker, instance: views.instance, sourceFiles: (origin) => views.sourceFiles(origin), reporter: makeReporter(outputChannel, 'sourceLanguage'),
    pathStanding: views.pathStanding,
  });
  const symbols = symbolsOver({ meditClient, asker, outputChannel, reporterFor, opened, views, focusedRecord: editor.focusedRecord });
  const agentServer = serveAgent({ port: agentPort(), instance: views.instance, copyReads: views.copyReads, symbols: symbols.symbols, problemsCaughtUp: () => sourceLanguage.problemsCaughtUp(), statuses: views.statuses, deployment: views.deployment, pluginsShown: views.pluginsShown, standing: { mEdit: () => plugins.standing.mEdit(), plugins: () => plugins.standing.plugins(), sortingRules: () => plugins.standing.sortingRules(), modList: () => views.modsLines(), sourceLanguage: () => sourceLanguage.messages(), unsavedSource: () => sourceLanguage.unsavedSourceMessages() }, mEdit: meditClient, terminalEnvironment: context.environmentVariableCollection, reporter: reporterFor('agent'), log: outputChannel });
  context.subscriptions.push(
    asker,
    views,
    plugins,
    editor,
    agentServer,
    vscode.languages.registerCodeActionsProvider({ scheme: 'file' }, quickFixes, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
    offerToVsCodeChat(agentServer),
    reachMEditFromTerminals(context.environmentVariableCollection, meditClient, scriptsPath),
    reachMEditFromEnvFile({
      client: meditClient, scriptsPath, envFile: opened.scriptEnvironmentFile,
      fail: (message, detail) => { scriptEnvironmentFailures.threw(scriptEnvironmentFailures, message, detail); },
    }),
    sourceLanguage,
    symbols,
  );
}

// Async so VS Code awaits confirmed-dead-child teardown before the extension host finishes
// tearing down — otherwise a reload's replacement client is structurally unable to ever clean up
// this instance's spawned child.
export async function deactivate(): Promise<void> {
  await stopMEditClient();
}

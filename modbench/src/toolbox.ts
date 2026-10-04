import * as vscode from 'vscode';
import type { MEditClient, PluginLoadFailure } from './client';
import { createLoadOrderSender, type LoadOrderSender } from './client';
import {
  createReconcileNarrator, subscribeNarratorToLoadOrderStatus, type ReconcileNarrator,
} from './medit/reconcileNarrator';
import { reportPutOutcome, settleReconciled, syncActiveFilter } from './medit/loadOrderOutcome';
import { PluginTreeProvider } from './plugins/PluginTreeProvider';
import { Instance, type InstanceValue } from './instanceLoader/instance';
import { dataFolderFile } from './tables/gamePaths';
import { isMo2Instance, mo2InstanceAdapter } from './instanceAdapter/mo2Instance';
import { ModListProvider, type ModlistNode } from './mods/ModListProvider';
import { InactiveFileDecorationProvider } from './mods/inactiveFiles';
import { ModIndicatorDecorations } from './mods/modIndicators';
import type { PluginFactsClient, PluginsTreeNode, PluginsTreeProvider } from './plugins/PluginsTreeProvider';
import { createPluginsView } from './plugins/pluginsView';
import type { Reporter } from './ports/reporter';
import type { AskQuestion } from './ports/dialog';
import type { MoveToTrash } from './ports/trash';
import { loadOrderSnapshotOf, originFiles, type OriginFilesOf } from './instanceLoader/loadOrderSnapshot';
import { DownloadsProvider, type DownloadsTreeNode } from './downloads/DownloadsProvider';
import { downloadsCopyValueText } from './downloads/keyContext';
import { ToolboxProvider } from './toolbox/ToolboxProvider';
import { registerFilterCommands, type NameFilter } from './drivingLib/nameFilter';
import { registerCopyValueCommand } from './drivingLib/copyValue';
import type { FocusedView } from './drivingLib/focusedView';
import { enterEditingAcrossRestarts } from './medit/backendStatus';
import { pluginSyncOver } from './pluginsCommands/plugins';
import { registerModSync } from './modSyncTrigger';
import { modSyncOver } from './modlist/modlist';
import { installNameRefusal } from './install/install';
import { pluginSyncArguments, registerPluginSync } from './pluginSyncTrigger';
import { say, exitEditing } from './editingTeardown';
import { registerModInstallCommands } from './mods/installCommands';
import { registerGoToModCommand } from './mods/goToMod';
import { registerFileExclusionCommands, registerModContextCommands, registerModEnableCommands, registerModMoveCommand, registerSeparatorCommands, registerCreateEmptyModCommand, registerModListCoreCommands, registerOpenFolderCommand, registerViewOnNexusCommand, modsCopyValueText, reportFailure } from './mods/modManagementCommands';
import { createModListView, lastSelectedViewSelection, nexusRowInLastSelectedView, registerDownloadsView } from './treeViews';
import { onModCheckboxChanged } from './mods/modCheckboxHandler';
import { modRepositoryContext } from './modRepositories';
import { answerInstanceCheck, gameDirectoryOverrides, markFirstReadLanded, type FirstReadMark } from './workspaceConfig';
import type { FolderCheck } from './folderContext';
import { refreshOnGameDirectoryChange } from './gameDirectorySetting';
import { logGameFolderNotFound } from './gameFolderNotFoundLog';
import { logDownloadsFolderUnresolved } from './downloadsFolderUnresolvedLog';
import { registerRefreshCommand, registerToolboxCommands } from './toolbox/toolboxCommands';
import {
  putLoadOrder, refresh, type LoadOrderSource, type PutLoadOrderResult,
} from './instanceCommands/loadOrder';
import { withPluginsViewProgress, type ExtensionSession, type Own } from './session';
import { pluginsCopyValueText, registerCreatePluginCommand } from './plugins/pluginListCommands';
import { errorMessage } from './ports/errorMessage';

// The port members every gesture, plugin sync and the launch in this file call.
export type ToolboxClient = Pick<MEditClient,
  'putLoadOrder' | 'rebuildIndex' | 'getActiveFilter' | 'createPlugin' | 'getLightPluginsSupported'
  | 'status' | 'start' | 'stop' | 'onStatusChanged' | 'onReconnected' | 'subscribe'>;

export interface ToolboxDeps {
  outputChannel: vscode.LogOutputChannel;
  session: ExtensionSession;
  client: ToolboxClient;
  /** The record browser the Plugins tree's rows expand into. Built by the editing side, which
   *  owns the single instance every record surface reads through. */
  recordBrowser: PluginTreeProvider;
  /** The mEdit client's members the Plugins view reads. */
  pluginFacts: PluginFactsClient;
  /** The one status bar item, written from the reconcile's own outcome. */
  setStatusText: (text: string) => void;
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

export interface LoadOrderPuts {
  /** The put when mEdit started, sent whatever the backend before it had: the backend just
   *  attached holds no load order. Until it runs, no recompute puts. */
  putOnMEditStarted(): Promise<void>;
}

// commands.md, put load order: put at every recompute and when mEdit started. Nothing is put while
// detached; a stream reopen is a start, the process behind it perhaps another.
export function registerLoadOrderPut(
  own: Own,
  instance: Pick<Instance, 'subscribe'>,
  client: Pick<MEditClient, 'onStatusChanged' | 'onReconnected'>,
  put: () => Promise<void>,
  channel: { error(msg: string): void },
): LoadOrderPuts {
  let startPutRan = false;
  const putLogged = (): void => {
    void put().catch((e: unknown) => channel.error(`[loadOrder] handing mEdit the load order threw: ${errorMessage(e)}`));
  };
  own({ dispose: client.onStatusChanged((status) => {
    if (status !== 'running') startPutRan = false;
  }) });
  own({ dispose: client.onReconnected(() => {
    if (!startPutRan) return;
    putLogged();
  }) });
  own(instance.subscribe(() => {
    if (startPutRan) putLogged();
  }));
  return {
    putOnMEditStarted: () => {
      startPutRan = true;
      return put();
    },
  };
}

interface ReconcileNarrationDeps {
  session: ExtensionSession;
  client: ToolboxClient;
  /** The record browser a reconciled load order refreshes — a different provider from
   *  `session.plugins`' tree, which `applyLoadOrderToTree` below owns. */
  recordBrowser: PluginTreeProvider;
  outputChannel: vscode.LogOutputChannel;
  setStatusText: (text: string) => void;
  notifyConflictsComputed: () => void;
  reporter: Reporter;
}

function applySyncedFilterState(
  client: Pick<MEditClient, 'getActiveFilter'>, session: ExtensionSession, outputChannel: vscode.LogOutputChannel,
  reporter: Reporter,
): Promise<void> {
  return syncActiveFilter(() => client.getActiveFilter(), {
    log: (m) => outputChannel.info(`[toolbox] ${m}`),
    warn: (m) => reporter.report('warning', m),
    showRecordFilter: (filter) => session.plugins?.showRecordFilter(filter),
  });
}

// plugins.md, States 2: the index status the stream carries drives the Plugins view, whoever
// started the reconcile. mEdit going away, or a stream reopening onto another process, starts its
// versions over.
function narrateReconciles(own: Own, deps: ReconcileNarrationDeps): ReconcileNarrator {
  const { session, client, recordBrowser, outputChannel, setStatusText, notifyConflictsComputed, reporter } = deps;
  const narrator = createReconcileNarrator({
    showProgress: (until) => void withPluginsViewProgress(session, () => until),
    applyIndexed: (indexedPlugins, failures) => session.plugins?.tree.applyIndexed(indexedPlugins, failures),
    applyRefused: (refusal) => session.plugins?.tree.applyRefused(refusal),
    setStatusText,
    settle: (status) => settleReconciled(status, {
      log: (m) => outputChannel.info(`[toolbox] ${m}`),
      warn: (m) => reporter.report('warning', m),
      setStatusText,
      refreshTree: () => recordBrowser.refresh(),
      notifyConflictsComputed,
      syncFilterState: () => applySyncedFilterState(client, session, outputChannel, reporter),
      applyReconciled: (failures, totalPlugins) => applyLoadOrderToTree(session, failures, outputChannel, reporter, totalPlugins),
    }),
    log: (m) => outputChannel.error(`[toolbox] ${m}`),
  });
  own({ dispose: subscribeNarratorToLoadOrderStatus(client, narrator) });
  own({ dispose: client.onStatusChanged((status) => { if (status !== 'running') narrator.detached(); }) });
  own({ dispose: client.onReconnected(() => narrator.detached()) });
  return narrator;
}

// Put load order (ADR-0013). What the reconcile does is the narrator's to show; what the send
// itself answered is reported here.
async function handleLoadOrder(
  outputChannel: vscode.LogOutputChannel, reporter: Reporter, narrator: ReconcileNarrator,
  command: () => Promise<PutLoadOrderResult>,
): Promise<void> {
  const put = await command();
  // A game folder not found, or one whose plugins cannot be listed, is told by the views and the
  // Output already; a line per value would repeat it.
  if (!put.sent) return;
  const { plugins, active } = put.snapshot;
  outputChannel.info(`[toolbox] handed mEdit the load order snapshot (${plugins.length} plugins, ${active.length} active)`);
  reportPutOutcome(put.outcome, { error: (m) => reporter.report('error', m) });
  if (put.outcome.outcome !== 'applied') return;
  // The status the put waited for, heard here too: its ticks can be lost to a stream reopening.
  narrator.hear(put.outcome.status);
  await narrator.settled(put.outcome.status.version);
}

// Rows gain chevrons here, and *finish* gaining them here. The tree reads the
// backend's own plugin list itself; the failures `reportLoadOrderResult` already toasted ride
// along rather than being re-derived.
async function applyLoadOrderToTree(
  session: ExtensionSession,
  failures: PluginLoadFailure[],
  outputChannel: vscode.LogOutputChannel,
  reporter: Reporter,
  // Carried in only to be logged next to what reached the tree. Deliberately not `plugins.length`
  // from the caller's snapshot: that omits the implicit masters the backend prepends, so every
  // healthy reconcile would read as short.
  totalPlugins: number,
): Promise<void> {
  const held = await session.plugins?.tree.applyReconciled(failures);
  if (held === undefined) {
    // Leaving every row a leaf is a safe *render* but not an honest one: the reconcile did land,
    // so the tree would claim editing is unavailable with nothing on screen to say why (ADR-0019).
    outputChannel.error('[toolbox] the reconciled load order did not reach the tree; plugin rows will not expand');
    reporter.report(
      'warning',
      'The load order was reconciled, but the plugin list could not be read — plugin rows will not expand into records.',
    );
    return;
  }
  // Do not remove as logging noise: `held.length + failures.length` landing close to
  // `totalPlugins` is what tells a stuck-tail reconcile here from one broken upstream.
  outputChannel.info(
    `[toolbox] applying reconciled load order to tree: ${held.length} in the load order, ${failures.length} failed, of ${totalPlugins} plugins`,
  );
}

// `loadOrderSender.arm()` returns a pure check, since the client holds no VS Code type (ADR-0019),
// so each call site logs explicitly instead.
function reportAbandoned(outputChannel: vscode.LogOutputChannel): void {
  outputChannel.info('[toolbox] the reconcile was abandoned before it landed; leaving the closed view alone');
}

interface EnterEditingDeps {
  session: ExtensionSession;
  instance: Instance;
  sender: LoadOrderSender;
  client: ToolboxClient;
  outputChannel: vscode.LogOutputChannel;
  reporter: Reporter;
  revealLog: () => void;
  /** What a connect runs once the Instance value it reads has landed. */
  onConnect: () => Promise<void>;
}

// Owns its own progress indicator rather than leaving each caller to wrap it, and
// reports its steps through `say`.
function makeEnterEditing(deps: EnterEditingDeps): () => Promise<void> {
  const { session, instance, sender, client, outputChannel, reporter, revealLog, onConnect } = deps;
  const enter = async (): Promise<void> => {
    const { abandoned } = sender.arm();
    // Overlaps with the backend starting below, same as the tree's own first-value wait: the
    // reconcile must read a real Instance value, never the empty pre-first-read sentinel.
    const instanceReady = instance.sequence > 0 ? Promise.resolve() : instance.refresh();
    revealLog(); // the launch can take a while; let the user watch the step log
    say(session, 'Starting backend…');
    outputChannel.info('[toolbox] entering editing: starting backend');
    await client.start();
    // Before the status gate, deliberately: a close stops the backend, so an abandoned launch
    // would otherwise fail this check and report the stop it asked for as a startup failure.
    if (abandoned()) { reportAbandoned(outputChannel); return; }
    if (client.status !== 'running') {
      exitEditing(session, client); // tear down the half-started backend
      reporter.report('error', 'Backend failed to start — see the Modbench output for details.');
      return;
    }
    await instanceReady;
    // No game folder, or one whose plugins cannot be listed, means no snapshot to hand over. The
    // views and the Output already say so, without a notification (common.md, States, story 5).
    if (!loadOrderSnapshotOf(instance.value)) {
      exitEditing(session, client);
      return;
    }
    await onConnect();
  };
  return () => withPluginsViewProgress(session, enter);
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
    setStatusText, notifyConflictsComputed, reporterFor, ask, trash, extensionId,
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
  own(logGameFolderNotFound(instance, (line) => outputChannel.warn(`[instance] ${line}`)));
  own(logDownloadsFolderUnresolved(instance, (line) => outputChannel.warn(`[instance] ${line}`)));
  // The Instance adapter watches files only, so an edited setting is the root's to hand to the same
  // recompute Refresh's re-read runs, once per burst under the Toolbox's own settle.
  own(refreshOnGameDirectoryChange(vscode.workspace.onDidChangeConfiguration, () => instance.refresh()));
  // Fire-and-forget: watchers alone leave the value at its EMPTY sentinel until a change, so
  // this kicks off the first real read. The Plugins tree's own `sequence === 0` guard is
  // what keeps activation from being blocking here.
  void instance.refresh();
  const modListProvider = own(new ModListProvider({ instance, access, log: (line) => outputChannel.warn(`[modList] ${line}`) }));
  own(vscode.window.registerFileDecorationProvider(own(new InactiveFileDecorationProvider(instance, vscode.workspace))));
  for (const provider of own(new ModIndicatorDecorations(instance, vscode.workspace)).providers) {
    own(vscode.window.registerFileDecorationProvider(provider));
  }
  // Held on the session as well, because the teardown writers outside this file abandon the
  // send in flight through it.
  const sender = own(createLoadOrderSender(client));
  session.loadOrderSender = sender;
  const loadOrderReporter = reporterFor('loadOrder');
  const narrator = narrateReconciles(own, {
    session, client, recordBrowser, outputChannel, setStatusText, notifyConflictsComputed,
    reporter: loadOrderReporter,
  });
  // The value's slice the load order is built from, under the names instance commands give it.
  const loadOrderSource = (): LoadOrderSource => {
    const { plugins, gameFolder, gameName, gameRelease, pluginsLoadedWithNoLine } = instance.value;
    return { plugins, gameFolder, gameName, gameRelease, pluginsLoadedWithNoLine };
  };
  const putCurrentLoadOrder = (): Promise<void> => handleLoadOrder(
    outputChannel, loadOrderReporter, narrator, () => putLoadOrder(sender, instanceRoot, loadOrderSource()));
  // commands.md, `refresh`: instance commands rebuild the index and send nothing; the gesture
  // itself asks the Instance loader to read every file again.
  const refreshIndex = () => refresh(client, instanceRoot, instance.value);
  // plugins.txt converges on what disk provides; the write reaches the Plugins tree and Editing's
  // Plugin load order sync through the Instance adapter's watch.
  const syncPluginsOver = pluginSyncOver(access);
  const runPluginSync = (value: InstanceValue) => syncPluginsOver(pluginSyncArguments(value));
  const pluginSync = own(registerPluginSync(instance, runPluginSync, outputChannel));
  const plugins = own(createPluginsView({
    instance, access, recordBrowser, client: pluginFacts, pluginSync, reporterFor,
    dataFolderFile: (name) => dataFolderFile(instance.value.gameFolder, name),
    // The tree states its own severity (ADR-0019); this routes it to the matching channel level.
    log: (level, msg) => outputChannel[level](msg),
  }));
  const { tree: pluginsTree, view: pluginListView, nameFilter: pluginsFilter } = plugins;
  session.plugins = plugins;
  const runModSync = modSyncOver(access);
  const modSync = own(registerModSync(instance, runModSync, outputChannel));
  const { modListView, modListFilter } = createModListView(
    own, modListProvider, (line) => outputChannel.warn(`[modList] ${line}`), modSync);
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
  const loadOrderPuts = registerLoadOrderPut(
    own, instance, client, putCurrentLoadOrder, outputChannel);
  const { enter: enterEditing } = own(enterEditingAcrossRestarts(
    client,
    makeEnterEditing({
      session, instance, sender, client, outputChannel, reporter: reporterFor('enterEditing'),
      revealLog: () => outputChannel.show(true), onConnect: () => loadOrderPuts.putOnMEditStarted(),
    }),
    (msg) => outputChannel.error(`[toolbox] ${msg}`),
  ));
  own(vscode.commands.registerCommand('modbench.instance.putLoadOrder', putCurrentLoadOrder));
  own(modListView.onDidChangeCheckboxState((e) =>
    onModCheckboxChanged(e, modListProvider, reporterFor('modList.checkbox'))));
  ownAll(own, registerModListCoreCommands(modListProvider));
  const toolboxProvider = own(new ToolboxProvider({ instance, log: (line) => outputChannel.warn(`[toolbox] ${line}`) }));
  ownAll(own, registerToolboxCommands({ access, instance, extensionId, reporterFor, marks: toolboxProvider }));
  ownAll(own, registerModContextCommands({
    access, instance, viewSelection: () => modListView.selection, reporter: reporterFor('mod.uninstall'), ask, trash,
    log: (line) => outputChannel.warn(`[modList] ${line}`), marks: modListProvider,
  }));
  ownAll(own, registerModEnableCommands(access, instance, () => modListView.selection, reporterFor('mod.enableDisable'), modListProvider));
  ownAll(own, registerFileExclusionCommands(access, () => modListView.selection, reporterFor('mod.excludeFile'), modListProvider));
  own(registerModMoveCommand(
    access, instance,
    { selection: () => modListView.selection, direction: () => modListProvider.viewDirection() },
    reporterFor('mod.move'), modListProvider));
  ownAll(own, registerSeparatorCommands(access, instance, reporterFor('separator'), ask, trash, () => modListView.selection, modListProvider));
  own(registerCreateEmptyModCommand(access, instance, reporterFor('mod.createEmpty'), modListProvider));
  own(registerOpenFolderCommand(instance, reporterFor('mod.openFolder'), () => modListView.selection));
  own(registerGoToModCommand(instance, reporterFor('mod.goToMod'), {
    selection: () => modListView.selection,
    rowFor: (origin) => modListProvider.rowFor(origin),
    reveal: (row) => modListView.reveal(row, { select: true, focus: true }),
  }));
  own(vscode.commands.registerCommand('modbench.mod.sync', runModSync));
  own(vscode.commands.registerCommand('modbench.plugin.sync', runPluginSync));
  const { downloadsProvider, downloadsView, downloadsFilter, installDownloaded } = registerDownloadsView({
    own, access, instance, reporter: reporterFor('downloadList'), ask, trash,
    install: {
      nameNewMod: (defaultName) => promptModName(defaultName, (name) => installNameRefusal(access, name)),
      warnIfFomod,
      log: (line) => outputChannel.warn(`[downloads] ${line}`),
    },
  });
  ownAll(own, registerModInstallCommands({ access, instance, runModAction, promptModName, warnIfFomod, installDownloaded }));
  own(registerViewOnNexusCommand(instance, reporterFor('mod.viewOnNexus'), nexusRowInLastSelectedView(own, [
    { id: 'modbench.modList', view: modListView }, { id: 'modbench.downloads', view: downloadsView },
  ])));
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
  const trackSelection = lastSelectedViewSelection(own, [
    { id: 'modbench.modList', view: modListView }, { id: 'modbench.pluginListTree', view: pluginListView },
  ], 'modbench.mod.trackRowsIn');
  own(registerRefreshCommand({
    refresh: refreshIndex, nextRefill: () => narrator.nextRefill(), instance, reporter: reporterFor('refresh'), instanceRoot,
  }));
  return {
    instance, instanceRoot, firstRead, modListProvider, toolboxProvider, downloadsProvider, pluginsTree, enterEditing,
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

  const provider = side?.toolboxProvider ?? own(new ToolboxProvider({ instance: undefined, log: () => undefined }));
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

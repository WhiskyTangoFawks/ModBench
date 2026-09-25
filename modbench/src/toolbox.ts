import * as vscode from 'vscode';
import type { MEditClient, PluginLoadFailure } from './client';
import { createLoadOrderSender, type LoadOrderSender } from './client';
import { implicitMastersFrom } from './toolboxClientCalls';
import {
  createReconcileNarrator, subscribeNarratorToLoadOrderStatus, type ReconcileNarrator,
} from './medit/reconcileNarrator';
import { reportPutOutcome, settleReconciled, syncActiveFilter } from './medit/loadOrderOutcome';
import { PluginTreeProvider } from './plugins/PluginTreeProvider';
import { publishLoadDiagnoses } from './medit/loadDiagnostics';
import { Instance, type InstanceValue } from './instanceLoader/instance';
import { dataFolderFile, dataFolderOf, gameDirectoryResolver } from './instanceAdapter/gameDirectory';
import { downloadsDirectoryResolver } from './instanceAdapter/downloadsDirectory';
import { isMo2Instance } from './instanceAdapter/files';
import { ModListProvider, type ModlistNode } from './mods/ModListProvider';
import { PluginsTreeProvider, type PluginFactsClient, type PluginListSource } from './plugins/PluginsTreeProvider';
import { gameReleaseForGame } from './tables/gamePaths';
import type { Reporter } from './ports/reporter';
import type { AskQuestion } from './ports/dialog';
import type { MoveToTrash } from './ports/trash';
import { loadOrderSnapshotOf, originFolder } from './instanceLoader/loadOrderSnapshot';
import { DownloadsProvider } from './downloads/DownloadsProvider';
import { ImplicitMasterDecorationProvider } from './plugins/ImplicitMasterDecorationProvider';
import { ToolboxProvider } from './toolbox/ToolboxProvider';
import { messageLine, registerNameFilter, type NameFilter } from './nameFilter';
import { enterEditingAcrossRestarts } from './medit/backendStatus';
import { onPluginCheckboxChanged } from './pluginCheckboxHandler';
import { syncPlugins, reorderPlugins, type ImplicitMasterSource } from './pluginsCommands/plugins';
import { syncMods } from './modlist/modlist';
import type { SyncMessage } from './syncFailureReport';
import { registerModSync } from './modSyncTrigger';
import { pluginSyncArguments, registerPluginSync } from './pluginSyncTrigger';
import { say, exitEditing } from './editingTeardown';
import { registerModInstallCommands, registerModContextCommands, registerModEnableCommands, registerModMoveCommand, registerSeparatorCommands, registerCreateEmptyModCommand, registerModListCoreCommands, registerOpenFolderCommand, registerViewOnNexusCommand, modsCopyValueText, reportFailure } from './mods/modManagementCommands';
import { createModListView, nexusRowInLastSelectedView, registerDownloadsView } from './mo2TreeViews';
import { onModCheckboxChanged } from './mods/modCheckboxHandler';
import { collidingModName } from './mods/modNameCollision';
import { answerInstanceCheck, gameDirectoryOverrides, markFirstReadLanded, type FirstReadMark } from './workspaceConfig';
import type { FolderCheck } from './folderContext';
import { refreshOnGameDirectoryChange } from './gameDirectorySetting';
import { logGameFolderNotFound } from './gameFolderNotFoundLog';
import { logDownloadsFolderUnresolved } from './downloadsFolderUnresolvedLog';
import { registerRefreshCommand, registerToolboxCommands } from './toolbox/toolboxCommands';
import {
  loadOrderChanged, putLoadOrder, refresh, type LoadOrderSource, type PutLoadOrderResult,
} from './instanceCommands/loadOrder';
import { withPluginsViewProgress, type ExtensionSession, type Own } from './session';
import { registerRevealInExplorerCommand, registerCreatePluginCommand } from './plugins/pluginListCommands';
import { registerPluginEnableCommands } from './plugins/pluginParticipationCommands';
import { pluginsKeyContext } from './plugins/gestureEntry';
import { errorMessage } from './ports/errorMessage';
import { applyOrThrow } from './ports/applyOrThrow';

// The port members every gesture, plugin sync and the launch in this file call — narrowed off
// `MEditClient` (ADR-0002), never the controller or the repository.
export type ToolboxClient = Pick<MEditClient,
  'putLoadOrder' | 'implicitMasters' | 'rebuildIndex' | 'getActiveFilter' | 'createPlugin'
  | 'status' | 'start' | 'stop' | 'onStatusChanged' | 'onReconnected' | 'subscribe'>;

export interface ToolboxDeps {
  outputChannel: vscode.LogOutputChannel;
  session: ExtensionSession;
  client: ToolboxClient;
  /** The record browser the Plugins tree's rows expand into. Built by the editing side, which
   *  owns the single instance every record surface reads through. */
  recordBrowser: PluginTreeProvider;
  /** The two mEdit reads the tree's badges and chevrons come from. */
  pluginFacts: PluginFactsClient;
  /** The malformed-plugin scan's Problems-panel collection. Held on the session so the teardown
   *  writers can clear both diagnosis surfaces together. */
  loadDiagnostics: vscode.DiagnosticCollection;
  /** The one status bar item, written from the reconcile's own outcome — never by the
   *  controller, a lower layer that presents nothing (ADR-0014 invariant 1). */
  setStatusText: (text: string) => void;
  /** Fires on every completed reconcile and on a landed Track: every open record panel refetches
   *  its comparison, and every tracked mod's repo (re-)registers with `vscode.git`. */
  notifyConflictsComputed: () => void;
  /** ADR-0019 surfacing: built per tag, so nothing below the entry point constructs an adapter
   *  and every gesture still names itself in the log. */
  reporterFor: (tag: string) => Reporter;
  /** ADR-0019 surfacing: the one modal question every gesture below here asks through. */
  ask: AskQuestion;
  /** The system trash every gesture below here moves a file to. */
  trash: MoveToTrash;
  /** Modbench's own extension ID, which scopes the Settings editor to its settings. */
  extensionId: string;
  /** Referenced By's own text for the catalog's one copy value id (Editor's own adapter,
   *  `referencedByCopyValueText`): copy value's Mods adapter is this file's own. */
  referencedByCopyValueText: (clicked: unknown, allSelected: readonly unknown[] | undefined) => string;
}

/** The MO2 side's wiring, which the activation file calls: the Toolbox view and everything below
 *  `modbench.toolbox` in the container is built here and torn down with it. */
export interface Toolbox extends vscode.Disposable {
  /** The instance check's answer, and whether the Instance's first value has landed. Exposed for
   *  integration tests, which cannot read a context key. */
  folder: FolderCheck;
  instanceRead: () => boolean;
  /** Absent together, on the paths with no MO2 instance to read. Exposed for integration
   *  tests — production reaches all of these through the views. */
  modListProvider?: ModListProvider;
  downloadsProvider?: DownloadsProvider;
  pluginsTree?: PluginsTreeProvider;
  instance?: Instance;
  enterEditing?: () => Promise<void>;
}

export interface LoadOrderPuts {
  /** The put that follows a connect, sent whatever the backend before it had: the backend just
   *  attached holds no load order. Until it runs, no recompute puts. */
  putOnConnect(): Promise<void>;
}

// update-load-order-file: put on change and on connect, running `onConnect` at each connect.
// Nothing is put while detached; a stream reopen is a connect, the process behind it perhaps
// another.
export function registerLoadOrderPut(
  own: Own,
  instance: Pick<Instance, 'subscribe'>,
  client: Pick<MEditClient, 'onStatusChanged' | 'onReconnected'>,
  changed: (value: InstanceValue) => boolean,
  put: () => Promise<void>,
  onConnect: () => void,
  channel: { error(msg: string): void },
): LoadOrderPuts {
  let connectPutRan = false;
  const putLogged = (): void => {
    void put().catch((e: unknown) => channel.error(`[loadOrder] handing mEdit the load order threw: ${errorMessage(e)}`));
  };
  own({ dispose: client.onStatusChanged((status) => {
    if (status !== 'attached') connectPutRan = false;
  }) });
  // Deferred past the other reopen listeners, the sender's forgetting what it sent among them.
  own({ dispose: client.onReconnected(() => {
    void Promise.resolve().then(() => {
      if (!connectPutRan) return;
      onConnect();
      putLogged();
    });
  }) });
  own(instance.subscribe((value) => {
    if (connectPutRan && changed(value)) putLogged();
  }));
  return {
    putOnConnect: () => {
      connectPutRan = true;
      onConnect();
      return put();
    },
  };
}

/** One surface's contribution to the catalog's one copy value id (commands.md, Record: copy
 *  value): its own text for this invocation, or `undefined` to defer to the next adapter. */
export interface CopyValueAdapter {
  text: (clicked: unknown, allSelected: readonly unknown[] | undefined) => string | undefined;
  reporterTag: string;
}

// Every surface the catalog names contributes an adapter, tried in order, so no surface's module
// needs to know another surface exists.
export function registerCopyValueCommand(
  adapters: readonly CopyValueAdapter[], reporterFor: (tag: string) => Reporter,
): vscode.Disposable {
  return vscode.commands.registerCommand('modbench.record.copyValue',
    async (clicked?: unknown, allSelected?: unknown[]) => {
      for (const adapter of adapters) {
        const text = adapter.text(clicked, allSelected);
        if (text === undefined) continue;
        if (!text) return;
        try {
          await vscode.env.clipboard.writeText(text);
        } catch (err) {
          reporterFor(adapter.reporterTag).report('error', 'Could not copy to the clipboard.', errorMessage(err));
        }
        return;
      }
    });
}


// The commands are free functions, so the composition root binds the instance root and the
// profile the Instance last landed, and turns a refusal into the rejection ADR-0019's
// notify-and-log path is written against.
function pluginListSource(instanceRoot: string, instance: Instance): PluginListSource {
  return {
    reorderPlugins: async (names, drop) =>
      applyOrThrow(await reorderPlugins(instanceRoot, instance.value.activeProfile, names, drop)),
  };
}

interface PluginListDeps {
  own: Own;
  session: ExtensionSession;
  outputChannel: vscode.LogOutputChannel;
  reporterFor: (tag: string) => Reporter;
  instanceRoot: string;
  /** The rows the game forces on, asked of the backend (ADR-0016). */
  implicitMasters: ImplicitMasterSource;
  /** ADR-0015: the tree's only row input — name, origin, slot, enabled and winning for every
   *  plugin. */
  instance: Instance;
  /** The record browser that supplies a plugin row's children. */
  recordBrowser: PluginTreeProvider;
  /** Every plugin-keyed fact the tree's badges read. */
  pluginFacts: PluginFactsClient;
  /** The malformed-plugin scan's Problems-panel collection. */
  loadDiagnostics: vscode.DiagnosticCollection;
  /** Plugin sync's failure, for the view's message line. */
  pluginSync: SyncMessage;
}

// ADR-0002: one tree, one owner — rows from the Instance, children from the record browser,
// every badge from the facts the provider pulls itself.
function registerPluginListView(deps: PluginListDeps): PluginsTreeProvider {
  const { own, session, outputChannel, reporterFor, instanceRoot, implicitMasters, instance } = deps;
  // The tree states its own severity (ADR-0019); this routes it to the matching channel level.
  const log = (level: 'info' | 'warn' | 'error', msg: string) => outputChannel[level](msg);
  const source = pluginListSource(instanceRoot, instance);
  const pluginsTree = own(new PluginsTreeProvider({
    instance, source, log, reporter: reporterFor('pluginList'), implicitMasters,
    dataFolderFile: (name) => dataFolderFile(instance.value.gameFolder, name),
    records: deps.recordBrowser,
    client: deps.pluginFacts,
    publishDiagnoses: (reports) => publishLoadDiagnoses(
      deps.loadDiagnostics, (origin) => originFolder(instance.value.plugins, origin), reports),
  }));
  session.pluginsTree = pluginsTree;
  const pluginListView = own(vscode.window.createTreeView('modbench.pluginListTree', {
    treeDataProvider: pluginsTree,
    canSelectMany: true,
    // A drag moves plugins.txt lines, which the same provider owns.
    dragAndDropController: pluginsTree,
    // commands.md, Chrome: Collapse All is on trees only, and this
    // one is hierarchical — plugin → record type → record.
    showCollapseAll: true,
  }));
  session.pluginsTreeView = pluginListView; // progress and message live here
  const showKeyContext = () => {
    for (const [name, value] of Object.entries(pluginsKeyContext(pluginListView.selection))) {
      void vscode.commands.executeCommand('setContext', `modbench.plugin.${name}`, value);
    }
    void vscode.commands.executeCommand('setContext', 'modbench.plugin.anyCompilable', pluginsTree.anyCompilable());
  };
  showKeyContext();
  own(pluginListView.onDidChangeSelection(showKeyContext));
  own(pluginsTree.onDidChangeTreeData(showKeyContext));
  session.pluginsNameFilter = own(registerPluginsNameFilter(pluginListView, pluginsTree, deps.pluginSync));
  // Grays an implicit master's row the way MO2 grays COL_NAME for a forceLoaded plugin — live
  // against the tree's own locked row URIs so it never drifts from what is rendered.
  own(vscode.window.registerFileDecorationProvider(
    new ImplicitMasterDecorationProvider(() => pluginsTree.lockedRowUris()),
  ));
  own(pluginListView.onDidChangeCheckboxState((e) => onPluginCheckboxChanged(
    e, instanceRoot, () => instance.value.activeProfile, reporterFor('pluginListTree.checkbox'), () => pluginsTree.invalidate())));
  own(registerRevealInExplorerCommand(pluginsTree, reporterFor('pluginListTree.revealInExplorer'), () => pluginListView.selection));
  ownAll(own, registerPluginEnableCommands(
    instanceRoot, instance, () => pluginListView.selection, reporterFor('pluginListTree.enableDisable')));
  return pluginsTree;
}

// The axis that narrows *which plugin rows* appear, composing with (never replacing) the record
// filter's axis over which records appear under an expanded row.
export function registerPluginsNameFilter(
  view: { description?: string; message?: string }, provider: PluginsTreeProvider,
  pluginSync: SyncMessage,
): NameFilter {
  return registerNameFilter({
    view, object: 'modbench.plugin', placeholder: 'Filter plugins…',
    setFilter: (text) => provider.setFilter(text),
    hasRows: async () => (await provider.getChildren()).length > 0,
    viewMessage: () => messageLine(provider.viewMessage(), pluginSync.message()),
    onRowsChanged: provider.onDidChangeTreeData,
    onViewMessageChanged: (listener) => pluginSync.onMessageChanged(listener),
  });
}


interface ReconcileNarrationDeps {
  session: ExtensionSession;
  client: ToolboxClient;
  /** The record browser a reconciled load order refreshes — a different provider from
   *  `session.pluginsTree`, which `applyLoadOrderToTree` below owns. */
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
    showRecordFilter: (filter) => session.showRecordFilter?.(filter),
  });
}

// plugins.md, States 2: the index status the stream carries drives the Plugins view, whoever
// started the reconcile. mEdit going away, or a stream reopening onto another process, starts its
// versions over.
function narrateReconciles(own: Own, deps: ReconcileNarrationDeps): ReconcileNarrator {
  const { session, client, recordBrowser, outputChannel, setStatusText, notifyConflictsComputed, reporter } = deps;
  const narrator = createReconcileNarrator({
    showProgress: (until) => void withPluginsViewProgress(session, () => until),
    applyIndexed: (indexedPlugins, failures) => session.pluginsTree?.applyIndexed(indexedPlugins, failures),
    applyRefused: (refusal) => session.pluginsTree?.applyRefused(refusal),
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
  own({ dispose: client.onStatusChanged((status) => { if (status !== 'attached') narrator.detached(); }) });
  own({ dispose: client.onReconnected(() => narrator.detached()) });
  return narrator;
}

// ADR-0013: instance commands hand the client the load order. What the reconcile does is the
// narrator's to show; what the send itself answered is reported here.
async function handleLoadOrder(
  outputChannel: vscode.LogOutputChannel, reporter: Reporter, narrator: ReconcileNarrator,
  command: () => Promise<PutLoadOrderResult>,
): Promise<void> {
  const put = await command();
  // The game folder not found has its own one Output line; a line per value would repeat it.
  if (!put.sent) return;
  const { plugins } = put.snapshot;
  outputChannel.info(`[toolbox] handed mEdit the load order snapshot (${plugins.length} plugins)`);
  reportPutOutcome(plugins, put.outcome, {
    warn: (m) => reporter.report('warning', m), error: (m) => reporter.report('error', m),
  });
  if (put.outcome.outcome !== 'applied') return;
  // The status the put waited for, heard here too: its ticks can be lost to a stream reopening.
  narrator.hear(put.outcome.status);
  await narrator.settled(put.outcome.status.version);
}

// ADR-0002: rows gain chevrons here — and *finish* gaining them here. The tree reads the
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
  const held = await session.pluginsTree?.applyReconciled(failures);
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

// `loadOrderSender.arm()` returns a pure check — it cannot hold an `outputChannel` (ADR-0013) —
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

// ADR-0002: owns its own progress indicator rather than leaving each caller to wrap it, and
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
    if (client.status !== 'attached') {
      exitEditing(session, client); // tear down the half-started backend
      reporter.report('error', 'Backend failed to start — see the Modbench output for details.');
      return;
    }
    await instanceReady;
    // No game folder means no snapshot to hand over. The Toolbox, the Plugins view and the Output
    // already say so, without a notification (common.md, States, story 5).
    if (!loadOrderSnapshotOf(instance.value)) {
      exitEditing(session, client);
      return;
    }
    await onConnect();
  };
  return () => withPluginsViewProgress(session, enter);
}


interface Mo2Side {
  instance: Instance;
  instanceRoot: string;
  firstRead: FirstReadMark;
  modListProvider: ModListProvider;
  downloadsProvider: DownloadsProvider;
  pluginsTree: PluginsTreeProvider;
  enterEditing: () => Promise<void>;
  // Copy value's Mods adapter reads this once an instance exists; createToolbox falls back to
  // undefined selection outside one, the same posture as `modListProvider` and its siblings.
  modListSelection: () => readonly ModlistNode[];
}

function buildMo2Side(own: Own, instanceRoot: string, deps: ToolboxDeps): Mo2Side {
  const {
    outputChannel, session, client, recordBrowser, pluginFacts, loadDiagnostics,
    setStatusText, notifyConflictsComputed, reporterFor, ask, trash, extensionId,
  } = deps;
  // The flat log shim, for collaborators still taking a flat `(msg) => void`.
  const log = (msg: string) => outputChannel.info(msg);
  // ADR-0015: the one Instance over MO2's files, recomputed from the instance directory and the
  // resolver the Instance adapter answers "where is the game" with.
  const instance = own(new Instance({
    instanceRoot, log, logReadFailure: (line) => outputChannel.error(line),
    resolveGameDirectory: gameDirectoryResolver(gameDirectoryOverrides),
    resolveDownloadsDirectory: downloadsDirectoryResolver(),
  }));
  const firstRead = own(markFirstReadLanded(instance));
  own(logGameFolderNotFound(instance, (line) => outputChannel.warn(`[instance] ${line}`)));
  own(logDownloadsFolderUnresolved(instance, (line) => outputChannel.warn(`[instance] ${line}`)));
  // The Instance watches files only, so an edited setting is the root's to hand to the same
  // recompute Refresh's re-read runs, once per burst under the Toolbox's own settle.
  own(refreshOnGameDirectoryChange(vscode.workspace.onDidChangeConfiguration, () => instance.refresh()));
  // The value's own resolution, read fresh per call: a config change is a recompute trigger like
  // any watched file, so the folder a view reads can never be a generation behind the rows.
  const dataFolder = (): Promise<string | undefined> =>
    Promise.resolve(dataFolderOf(instance.value.gameFolder));
  // Fire-and-forget: watchers alone leave the value at its EMPTY sentinel until a change, so
  // this kicks off the first real read. The Plugins tree's own `sequence === 0` guard is
  // what keeps activation from being blocking here.
  void instance.refresh();
  // ADR-0015: rows, statuses and the overwrite count all come from the Instance value now —
  // this provider builds no index and reads no disk of its own.
  const modListProvider = own(new ModListProvider({ instance, instanceRoot }));
  // Held on the session as well, because the teardown writers outside this file abandon the
  // send in flight through it (ADR-0013).
  const sender = own(createLoadOrderSender(client));
  session.loadOrderSender = sender;
  const loadOrderReporter = reporterFor('loadOrder');
  const narrator = narrateReconciles(own, {
    session, client, recordBrowser, outputChannel, setStatusText, notifyConflictsComputed,
    reporter: loadOrderReporter,
  });
  // The value's slice the load order is built from, under the names instance commands give it.
  const loadOrderSource = (value = instance.value): LoadOrderSource =>
    ({ plugins: value.plugins, gameFolder: value.gameFolder, gameName: value.gameRelease });
  const putCurrentLoadOrder = (): Promise<void> => handleLoadOrder(
    outputChannel, loadOrderReporter, narrator, () => putLoadOrder(sender, instanceRoot, loadOrderSource()));
  // load-instance, refresh: instance commands rebuild the index and send nothing; the gesture
  // itself asks the Instance loader to read every file again.
  const refreshIndex = () => refresh(client, instanceRoot, instance.value.gameRelease);
  // The backend answers this, never the extension (ADR-0016), and it needs both the Data folder
  // and the game. An unresolved folder, a game with no Mutagen release, and an unreachable
  // backend are one answer: unknown.
  const implicitMastersIn = (folder: string | undefined, gameName: string): Promise<string[] | undefined> =>
    implicitMastersFrom(client, folder, gameReleaseForGame(gameName));
  // plugins.txt converges on what disk provides; the write reaches the Plugins tree and Editing's
  // Plugin load order sync through the plugins.txt watcher.
  const runPluginSync = (value: InstanceValue) => {
    const { profile, provided, inData, dataFolder, gameName } = pluginSyncArguments(value);
    return syncPlugins(instanceRoot, profile, provided, inData, () => implicitMastersIn(dataFolder, gameName));
  };
  const pluginSync = own(registerPluginSync(instance, runPluginSync, outputChannel));
  const pluginsTree = registerPluginListView({
    own, session, outputChannel, reporterFor, instanceRoot,
    implicitMasters: async () => implicitMastersIn(await dataFolder(), instance.value.gameRelease),
    instance, recordBrowser, pluginFacts, loadDiagnostics, pluginSync,
  });
  const runModSync = (value: InstanceValue) => syncMods(instanceRoot, value.activeProfile, value.modFolders);
  const modSync = own(registerModSync(instance, runModSync, outputChannel));
  const { modListView } = createModListView(
    own, modListProvider, (line) => outputChannel.warn(`[modList] ${line}`), modSync);
  const runModAction = (logLabel: string, failMessage: string, action: () => Promise<void>) =>
    reportFailure(reporterFor(logLabel), failMessage, action);
  const promptModName = (defaultName: string, validateInput?: (value: string) => string | undefined) =>
    vscode.window.showInputBox({ prompt: 'Mod name', value: defaultName, validateInput });
  const warnIfFomod = (name: string, isFomod: boolean) => {
    if (isFomod)
      reporterFor('install').report(
        'warning',
        `"${name}" is a FOMOD installer — its files were copied as-is and need manual ` +
          `arrangement; Modbench does not run the installer's own install steps.`,
      );
  };
  // ADR-0013: a landed Instance recompute and a connect put the load order, never a gesture.
  const loadOrderPuts = registerLoadOrderPut(
    own, instance, client, (value) => loadOrderChanged(sender, instanceRoot, loadOrderSource(value)),
    putCurrentLoadOrder, () => pluginSync.runOnConnect(), outputChannel);
  const { enter: enterEditing } = own(enterEditingAcrossRestarts(
    client,
    makeEnterEditing({
      session, instance, sender, client, outputChannel, reporter: reporterFor('enterEditing'),
      revealLog: () => outputChannel.show(true), onConnect: () => loadOrderPuts.putOnConnect(),
    }),
    (msg) => outputChannel.error(`[toolbox] ${msg}`),
  ));
  own(vscode.commands.registerCommand('modbench.instance.putLoadOrder', putCurrentLoadOrder));
  own(modListView.onDidChangeCheckboxState((e) =>
    onModCheckboxChanged(e, modListProvider, reporterFor('modList.checkbox'))));
  ownAll(own, registerModListCoreCommands(modListProvider));
  ownAll(own, registerToolboxCommands({ instanceRoot, instance, extensionId, reporterFor }));
  ownAll(own, registerModInstallCommands({ instanceRoot, instance, runModAction, promptModName, warnIfFomod }));
  ownAll(own, registerModContextCommands(
    instanceRoot, instance, () => modListView.selection, reporterFor('mod.uninstall'), ask, trash,
    (line) => outputChannel.warn(`[modList] ${line}`)));
  ownAll(own, registerModEnableCommands(instanceRoot, instance, () => modListView.selection, reporterFor('mod.enableDisable')));
  own(registerModMoveCommand(
    instanceRoot, instance,
    { selection: () => modListView.selection, direction: () => modListProvider.viewDirection() },
    reporterFor('mod.move')));
  ownAll(own, registerSeparatorCommands(instanceRoot, instance, reporterFor('separator'), trash, () => modListView.selection));
  own(registerCreateEmptyModCommand(instanceRoot, instance, reporterFor('mod.createEmpty')));
  own(registerOpenFolderCommand(instance, reporterFor('mod.openFolder'), () => modListView.selection));
  own(vscode.commands.registerCommand('modbench.mod.sync', runModSync));
  own(vscode.commands.registerCommand('modbench.plugin.sync', runPluginSync));
  const { downloadsProvider, downloadsView } = registerDownloadsView({
    own, instanceRoot, instance, reporter: reporterFor('downloadList'), ask, trash,
    install: {
      nameNewMod: (defaultName) => promptModName(defaultName, (name) => collidingModName(instance, name)),
      warnIfFomod,
      log: (line) => outputChannel.warn(`[downloads] ${line}`),
    },
  });
  own(registerViewOnNexusCommand(instance, reporterFor('mod.viewOnNexus'), nexusRowInLastSelectedView(own, [
    { id: 'modbench.modList', view: modListView }, { id: 'modbench.downloads', view: downloadsView },
  ])));
  own(registerRefreshCommand({
    refresh: refreshIndex, nextRefill: () => narrator.nextRefill(), instance, reporter: reporterFor('refresh'), instanceRoot,
  }));
  return {
    instance, instanceRoot, firstRead, modListProvider, downloadsProvider, pluginsTree, enterEditing,
    modListSelection: () => modListView.selection,
  };
}

const ownAll = (own: Own, disposables: vscode.Disposable[]): void => {
  for (const disposable of disposables) own(disposable);
};

type OpenedFolder = { folder: 'instance'; instanceRoot: string } | { folder: 'notAnInstance' };

// Outside an instance only the Toolbox registers, row-less, and each view's `viewsWelcome` says
// why. An instance whose files cannot be read is still an instance: its views show the error row
// (ADR-0019).
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
  const mo2 = opened.folder === 'instance' ? buildMo2Side(own, opened.instanceRoot, deps) : undefined;

  const provider = own(new ToolboxProvider({ instance: mo2?.instance }));
  own(vscode.window.createTreeView('modbench.toolbox', { treeDataProvider: provider }));
  own(registerCreatePluginCommand(client, mo2, reporterFor('newPlugin')));
  // Registered here, not inside buildMo2Side: Referenced By's own copy reaches this regardless
  // of whether the folder is an instance.
  own(registerCopyValueCommand(
    [
      { text: mo2 ? modsCopyValueText(() => mo2.modListSelection()) : () => undefined, reporterTag: 'mod.copyValue' },
      { text: deps.referencedByCopyValueText, reporterTag: 'referencedByTree.copy' },
    ],
    reporterFor,
  ));

  return {
    folder: opened.folder,
    instanceRead: () => mo2?.firstRead.landed ?? false,
    modListProvider: mo2?.modListProvider,
    downloadsProvider: mo2?.downloadsProvider,
    pluginsTree: mo2?.pluginsTree,
    instance: mo2?.instance,
    enterEditing: mo2?.enterEditing,
    dispose: () => {
      for (const disposable of owned.reverse()) disposable.dispose();
      owned.length = 0;
    },
  };
}

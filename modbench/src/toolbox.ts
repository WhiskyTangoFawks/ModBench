import * as vscode from 'vscode';
import type {
  LoadOrderStatus as LoadOrderProgress, MEditClient, PluginLoadFailure,
} from './client';
import { createLoadOrderSender, type LoadOrderSender, type LoadOrderSendOptions } from './client';
import { implicitMastersFrom } from './toolboxClientCalls';
import { makeReconcileProgressHandler, reportIndexRefusal } from './medit/loadOrderProgress';
import { applyLoadOrderOutcome, syncActiveFilter } from './medit/loadOrderOutcome';
import { PluginTreeProvider } from './plugins/PluginTreeProvider';
import { publishLoadDiagnoses } from './medit/loadDiagnostics';
import { Instance } from './instanceLoader/instance';
import { gameDirectoryResolver } from './instanceAdapter/gameDirectory';
import { isMo2Instance } from './instanceAdapter/files';
import { ModListProvider } from './mods/ModListProvider';
import { PluginsTreeProvider, type PluginFactsClient, type PluginListSource } from './plugins/PluginsTreeProvider';
import { gameReleaseForGame } from './tables/gamePaths';
import type { Reporter } from './ports/reporter';
import type { AskQuestion } from './ports/dialog';
import { loadOrderSnapshotOf, originFolder, type DataFolderPlugins } from './instanceLoader/loadOrderSnapshot';
import { DownloadsProvider } from './downloads/DownloadsProvider';
import { ImplicitMasterDecorationProvider } from './plugins/ImplicitMasterDecorationProvider';
import { ToolboxProvider } from './toolbox/ToolboxProvider';
import { registerNameFilter, type NameFilter } from './nameFilter';
import { enterEditingAcrossRestarts } from './medit/backendStatus';
import { onPluginCheckboxChanged } from './pluginCheckboxHandler';
import { syncPlugins, reorderPlugins, setPluginEnabled, type ImplicitMasterSource } from './pluginsCommands/plugins';
import { syncMods } from './modlist/modlist';
import { registerModSync } from './modSyncTrigger';
import { registerPluginSync } from './pluginSyncTrigger';
import { say, exitEditing } from './editingTeardown';
import { registerModInstallCommands, registerModContextCommands, registerSeparatorCommands, registerCreateEmptyModCommand, registerOverwriteView, registerModListCoreCommands, registerOpenFolderCommand, registerViewOnNexusCommand } from './mods/modManagementCommands';
import { createModListView, registerDownloadsView } from './mo2TreeViews';
import { onModCheckboxChanged } from './mods/modCheckboxHandler';
import { collidingModName } from './mods/modNameCollision';
import { answerInstanceCheck, gameDirectoryOverrides, markFirstReadLanded, type FirstReadMark } from './workspaceConfig';
import type { FolderCheck } from './folderContext';
import { refreshOnGameDirectoryChange } from './gameDirectorySetting';
import { registerRefreshCommand, registerToolboxCommands, type RefreshGestureDeps } from './toolbox/toolboxCommands';
import { putLoadOrder, refresh, type LoadOrderSource, type PutLoadOrderResult } from './instanceCommands/loadOrder';
import { withPluginsViewProgress, type ExtensionSession, type Own } from './session';
import { registerRevealInExplorerCommand, registerCreatePluginCommand } from './plugins/pluginListCommands';
import { errorMessage } from './ports/errorMessage';
import { applyOrThrow } from './ports/applyOrThrow';

// The port members every gesture, plugin sync and the launch in this file call — narrowed off
// `MEditClient` (ADR-0002), never the controller or the repository.
export type ToolboxClient = Pick<MEditClient,
  'putLoadOrder' | 'implicitMasters' | 'rebuildIndex' | 'getActiveFilter' | 'createPlugin'
  | 'status' | 'start' | 'stop' | 'onStatusChanged'>;

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


// The commands are free functions, so the composition root binds the instance root and the
// profile the Instance last landed, and turns a refusal into the rejection ADR-0019's
// notify-and-log path is written against.
function pluginListSource(instanceRoot: string, instance: Instance): PluginListSource {
  return {
    setPluginEnabled: async (name, enabled) =>
      applyOrThrow(await setPluginEnabled(instanceRoot, instance.value.activeProfile, name, enabled)),
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
  // A getter over the Instance value's own resolution, not a Promise settled once. Undefined
  // when nothing resolved, which leaves an implicit row without a file to point at.
  dataFolder: () => Promise<string | undefined>;
  /** The rows the game forces on, asked of the backend (ADR-0016). */
  implicitMasters: ImplicitMasterSource;
  /** ADR-0015: the tree's only row input — name, origin, slot, enabled and winning for every
   *  plugin copy. */
  instance: Instance;
  /** The record browser that supplies a plugin row's children. */
  recordBrowser: PluginTreeProvider;
  /** Every plugin-keyed fact the tree's badges read. */
  pluginFacts: PluginFactsClient;
  /** The malformed-plugin scan's Problems-panel collection. */
  loadDiagnostics: vscode.DiagnosticCollection;
}

// ADR-0002: one tree, one owner — rows from the Instance, children from the record browser,
// every badge from the facts the provider pulls itself.
function registerPluginListView(deps: PluginListDeps): PluginsTreeProvider {
  const { own, session, outputChannel, reporterFor, instanceRoot, dataFolder, implicitMasters, instance } = deps;
  // The tree states its own severity (ADR-0019); this routes it to the matching channel level.
  const log = (level: 'info' | 'warn' | 'error', msg: string) => outputChannel[level](msg);
  const source = pluginListSource(instanceRoot, instance);
  const pluginsTree = own(new PluginsTreeProvider({
    instance, source, log, reporter: reporterFor('pluginList'), dataFolder, implicitMasters,
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
    // Title-bar rule 7 (docs/specs/containers.md): hierarchical trees get Collapse All, and this
    // one is hierarchical — plugin → record type → record.
    showCollapseAll: true,
  }));
  session.pluginsTreeView = pluginListView; // progress and message live here
  session.pluginsNameFilter = own(registerPluginsNameFilter(pluginListView, pluginsTree));
  // Grays an implicit master's row the way MO2 grays COL_NAME for a forceLoaded plugin — live
  // against the tree's own implicitMasterNames() so it never drifts from what is rendered.
  own(vscode.window.registerFileDecorationProvider(
    new ImplicitMasterDecorationProvider(dataFolder, () => pluginsTree.implicitMasterNames()),
  ));
  own(pluginListView.onDidChangeCheckboxState((e) => onPluginCheckboxChanged(e, pluginsTree, outputChannel)));
  own(registerRevealInExplorerCommand(pluginsTree, reporterFor('pluginListTree.revealInExplorer')));
  return pluginsTree;
}

// The axis that narrows *which plugin rows* appear, composing with (never replacing) the record
// filter's axis over which records appear under an expanded row.
export function registerPluginsNameFilter(
  view: { description?: string; message?: string }, provider: PluginsTreeProvider,
): NameFilter {
  return registerNameFilter({
    view, object: 'modbench.plugin', placeholder: 'Filter plugins…',
    setFilter: (text) => provider.setFilter(text),
    hasRows: async () => (await provider.getChildren()).length > 0,
    onRowsChanged: provider.onDidChangeTreeData,
  });
}


interface LoadOrderHandlingDeps {
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
    setFilterActive: (active, sql, label) => session.setFilterActive?.(active, sql, label),
  });
}

// ADR-0013: instance commands hand the client the load order, and the answer is reported and
// applied here, where the views are. `loadOrderOf` picks the put out of the answer: undefined
// when nothing was sent.
function handleLoadOrder<T>(
  deps: LoadOrderHandlingDeps,
  command: (options: LoadOrderSendOptions) => Promise<T>,
  loadOrderOf: (answer: T) => PutLoadOrderResult | undefined,
): Promise<T> {
  const { session, client, setStatusText } = deps;
  const run = async (): Promise<T> => {
    const treeProgress = makeTreeProgressHandler(session);
    const answer = await command({
      // The Index's own known refusal rides a tick, never the put's own outcome (ADR-0013) — this
      // is the only place it is seen, so it is checked on every one, not folded into treeProgress.
      onProgress: (status: LoadOrderProgress): void => {
        reportIndexRefusal(status, { setStatusText });
        treeProgress.onProgress(status);
      },
    });
    const put = loadOrderOf(answer);
    if (put) await settleLoadOrder(deps, treeProgress, put);
    return answer;
  };
  // A snapshot handed over before mEdit is attached waits on the client for the connect, so
  // narrating it would leave the Plugins view spinning on a load nobody has asked for yet.
  return client.status === 'attached' ? withPluginsViewProgress(session, run) : run();
}

async function settleLoadOrder(
  deps: LoadOrderHandlingDeps, treeProgress: TreeProgressHandler, put: PutLoadOrderResult,
): Promise<void> {
  const { session, client, recordBrowser, outputChannel, setStatusText, notifyConflictsComputed, reporter } = deps;
  if (!put.sent) {
    outputChannel.info('[toolbox] no game directory resolved — there is no load order to hand mEdit');
    return;
  }
  const { plugins } = put.snapshot;
  outputChannel.info(`[toolbox] handed mEdit the load order snapshot (${plugins.length} plugin copies)`);
  await applyLoadOrderOutcome(plugins, put.outcome, treeProgress.lastFailures(), treeProgress.lastTotalPlugins(), {
    log: (m) => outputChannel.info(`[toolbox] ${m}`),
    warn: (m) => reporter.report('warning', m),
    error: (m) => reporter.report('error', m),
    setStatusText,
    refreshTree: () => recordBrowser.refresh(),
    notifyConflictsComputed,
    syncFilterState: () => applySyncedFilterState(client, session, outputChannel, reporter),
    applyReconciled: (failures, totalPlugins) => applyLoadOrderToTree(session, failures, outputChannel, reporter, totalPlugins),
  });
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
      'The load order was reconciled, but the plugin list could not be read — plugin rows will not expand into records. Close and relaunch mEdit to retry.',
    );
    return;
  }
  // Do not remove as logging noise: `held.length + failures.length` landing close to
  // `totalPlugins` is what tells a stuck-tail reconcile here from one broken upstream.
  outputChannel.info(
    `[toolbox] applying reconciled load order to tree: ${held.length} in the load order, ${failures.length} failed, of ${totalPlugins} copies`,
  );
}

// Each tick's `totalPlugins` is the backend's count, implicit masters included — a larger number
// than the frontend's own snapshot, and the one `applyLoadOrderToTree`'s completion log compares
// against.
interface TreeProgressHandler {
  onProgress: (status: LoadOrderProgress) => void;
  lastTotalPlugins: () => number;
  /** The last tick's own failures — the PUT response carries none of its own (ADR-0019). */
  lastFailures: () => PluginLoadFailure[];
}

function makeTreeProgressHandler(session: ExtensionSession): TreeProgressHandler {
  let totalPlugins = 0;
  let failures: PluginLoadFailure[] = [];
  const applyTick = makeReconcileProgressHandler({
    applyLoadOrder: (indexedPlugins, tickFailures) => session.pluginsTree?.applyIndexed(indexedPlugins, tickFailures),
  });
  return {
    onProgress: (status) => { totalPlugins = status.totalPlugins; failures = status.failures; applyTick(status); },
    lastTotalPlugins: () => totalPlugins,
    lastFailures: () => failures,
  };
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
  putCurrentLoadOrder: () => Promise<void>;
}

// ADR-0002: owns its own progress indicator rather than leaving each caller to wrap it, and
// reports its steps through `say`.
function makeEnterEditing(deps: EnterEditingDeps): () => Promise<void> {
  const { session, instance, sender, client, outputChannel, reporter, revealLog, putCurrentLoadOrder } = deps;
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
    // No game directory means no snapshot to hand over — don't strand the UI in an empty editing
    // view. This is the one path that asked for a load order, so this is where it is reported.
    if (!loadOrderSnapshotOf(instance.value)) {
      reporter.report(
        'error',
        'No game directory found. Set modbench.mods.gameDirectory to your Stock Game Folder or Steam install.',
      );
      exitEditing(session, client);
      return;
    }
    await putCurrentLoadOrder();
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
  refreshGesture: RefreshGestureDeps;
  enterEditing: () => Promise<void>;
}

function buildMo2Side(own: Own, instanceRoot: string, deps: ToolboxDeps): Mo2Side {
  const {
    outputChannel, session, client, recordBrowser, pluginFacts, loadDiagnostics,
    setStatusText, notifyConflictsComputed, reporterFor, ask,
  } = deps;
  // The flat log shim, for collaborators still taking a flat `(msg) => void`.
  const log = (msg: string) => outputChannel.info(msg);
  const modListReporter = reporterFor('modList');
  // ADR-0015: the one Instance over MO2's files, recomputed from the instance directory and the
  // resolver the Instance adapter answers "where is the game" with.
  const instance = own(new Instance({
    instanceRoot, log, logReadFailure: (line) => outputChannel.error(line),
    resolveGameDirectory: gameDirectoryResolver(gameDirectoryOverrides),
  }));
  const firstRead = own(markFirstReadLanded(instance));
  // The Instance watches files only, so an edited setting is the root's to hand to the same
  // recompute Refresh's re-read runs, once per burst under the Toolbox's own settle.
  own(refreshOnGameDirectoryChange(vscode.workspace.onDidChangeConfiguration, () => instance.refresh()));
  // The value's own resolution, read fresh per call: a config change is a recompute trigger like
  // any watched file, so the folder a view reads can never be a generation behind the rows.
  const dataFolder = (): Promise<string | undefined> =>
    Promise.resolve(instance.value.gameDirectory?.dataFolder);
  // Fire-and-forget: watchers alone leave the value at its EMPTY sentinel until a change, so
  // this kicks off the first real read. The Plugins tree's own `sequence === 0` guard is
  // what keeps activation from being blocking here.
  void instance.refresh();
  // ADR-0015: rows, statuses and the overwrite count all come from the Instance value now —
  // this provider builds no index and reads no disk of its own.
  const modListProvider = own(new ModListProvider({ instance, log, instanceRoot, reporter: modListReporter }));
  // Held on the session as well, because the teardown writers outside this file abandon the
  // send in flight through it (ADR-0013).
  const sender = own(createLoadOrderSender(client));
  session.loadOrderSender = sender;
  const handlingDeps: LoadOrderHandlingDeps = {
    session, client, recordBrowser, outputChannel, setStatusText, notifyConflictsComputed,
    reporter: reporterFor('loadOrder'),
  };
  // The value's slice the load order is built from, under the names instance commands give it.
  const loadOrderSource = (): LoadOrderSource => {
    const { plugins, gameDirectory, gameRelease } = instance.value;
    return { plugins, gameDirectory, gameName: gameRelease };
  };
  const putCurrentLoadOrder = async (): Promise<void> => {
    await handleLoadOrder(
      handlingDeps, (options) => putLoadOrder(sender, instanceRoot, loadOrderSource(), options), (put) => put);
  };
  // ADR-0014: instance commands rebuild the index and then put the load order; the gesture itself
  // asks the Instance loader to read every file again.
  const refreshIndex = () => handleLoadOrder(
    handlingDeps, (options) => refresh(client, sender, instanceRoot, loadOrderSource(), options),
    (answer) => (answer.applied ? answer.loadOrder : undefined));
  // The backend answers this, never the extension (ADR-0016), and it needs both the Data folder
  // and the game. An unresolved folder, a game with no Mutagen release, and an unreachable
  // backend are one answer: unknown.
  const implicitMastersIn = (folder: string | undefined, gameName: string): Promise<string[] | undefined> =>
    implicitMastersFrom(client, folder, gameReleaseForGame(gameName));
  // plugins.txt converges on what disk provides; the write reaches the Plugins tree and Editing's
  // Plugin load order sync through the plugins.txt watcher.
  const runPluginSync = (
    profile: string, provided: ReadonlyMap<string, string>, inData: DataFolderPlugins,
    folder: string | undefined, gameName: string,
  ) => syncPlugins(
    instanceRoot, profile, provided, inData, () => implicitMastersIn(folder, gameName),
    (msg) => outputChannel.debug(msg));
  const pluginsTree = registerPluginListView({
    own, session, outputChannel, reporterFor, instanceRoot, dataFolder,
    implicitMasters: async () => implicitMastersIn(await dataFolder(), instance.value.gameRelease),
    instance, recordBrowser, pluginFacts, loadDiagnostics,
  });
  const { modListView, updateProfileDescription } = createModListView(own, modListProvider, instance);
  const runModAction = async (logLabel: string, failMessage: string, action: () => Promise<void>) => {
    try {
      await action();
      modListProvider.invalidate();
    } catch (err) {
      reporterFor(logLabel).report('error', failMessage, errorMessage(err));
    }
  };
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
  const { enter: enterEditing } = own(enterEditingAcrossRestarts(
    client,
    makeEnterEditing({
      session, instance, sender, client, outputChannel, reporter: reporterFor('enterEditing'),
      revealLog: () => outputChannel.show(true), putCurrentLoadOrder,
    }),
    (msg) => outputChannel.error(`[toolbox] ${msg}`),
  ));
  // ADR-0013: the one trigger for a PUT — a landed Instance recompute, never a gesture. A throw
  // in the applied outcome is logged here, because no caller is left to hear it.
  own(instance.subscribe(() => void putCurrentLoadOrder().catch((e: unknown) => outputChannel.error(
    `[toolbox] handing mEdit the load order threw: ${errorMessage(e)}`))));
  own(modListView.onDidChangeCheckboxState((e) =>
    onModCheckboxChanged(e, modListProvider, reporterFor('modList.checkbox'))));
  ownAll(own, registerModListCoreCommands(modListProvider));
  ownAll(own, registerToolboxCommands({ instanceRoot, instance, updateProfileDescription, reporterFor }));
  ownAll(own, registerModInstallCommands({ instanceRoot, instance, runModAction, promptModName, warnIfFomod }));
  ownAll(own, registerModContextCommands(instanceRoot, instance, runModAction, ask));
  ownAll(own, registerSeparatorCommands(instanceRoot, instance, runModAction));
  own(registerCreateEmptyModCommand(instanceRoot, instance, runModAction));
  own(registerOverwriteView(instance));
  own(registerOpenFolderCommand(instance, reporterFor('mod.openFolder')));
  own(registerViewOnNexusCommand(instance, reporterFor('mod.viewOnNexus')));
  own(registerModSync(instance, (profile, modFolders) => syncMods(instanceRoot, profile, modFolders), outputChannel));
  own(registerPluginSync(instance, runPluginSync, outputChannel));
  const downloadsProvider = registerDownloadsView(own, instanceRoot, instance, reporterFor('downloadList'), ask, {
    nameNewMod: (defaultName) => promptModName(defaultName, (name) => collidingModName(instance, name)),
    warnIfFomod,
  });
  const refreshGesture = { refresh: refreshIndex, instance, reporter: reporterFor('refresh') };
  return { instance, instanceRoot, firstRead, modListProvider, downloadsProvider, pluginsTree, refreshGesture, enterEditing };
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

  // ADR-0015: the view's rows are the Instance's value. The provider holds no state and reads
  // no disk, so a landed recompute is the only thing that can change what it shows.
  const provider = new ToolboxProvider({
    state: () => (mo2 ? { activeProfile: mo2.instance.value.activeProfile } : undefined),
  });
  own(vscode.window.createTreeView('modbench.toolbox', { treeDataProvider: provider }));
  if (mo2) own(mo2.instance.subscribe(() => provider.refresh()));
  own(registerRefreshCommand(mo2?.refreshGesture));
  own(registerCreatePluginCommand(client, mo2, reporterFor('newPlugin')));

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

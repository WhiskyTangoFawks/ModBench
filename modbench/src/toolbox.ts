import * as vscode from 'vscode';
import type {
  LoadOrderStatus as LoadOrderProgress, MEditClient, PluginLoadFailure,
} from './client';
import { createLoadOrderSender, type LoadOrderSender } from './client';
import { implicitMastersFrom, rebuildIndexVia } from './toolboxClientCalls';
import { makeReconcileProgressHandler, reportIndexRefusal } from './medit/loadOrderProgress';
import { applyLoadOrderOutcome, syncActiveFilter } from './medit/loadOrderOutcome';
import { PluginTreeProvider } from './plugins/PluginTreeProvider';
import { publishLoadDiagnoses } from './medit/loadDiagnostics';
import { Instance, loadOrderSnapshotOf } from './instance/instance';
import { gameDirectoryResolver } from './mo2Files/gameDirectory';
import { isMo2Instance } from './mo2Files/files';
import { ModListProvider } from './mods/ModListProvider';
import { PluginsTreeProvider, type PluginFactsClient, type PluginsTreeNode, type PluginListSource } from './plugins/PluginsTreeProvider';
import { gameReleaseForGame } from './tables/gamePaths';
import type { Reporter } from './ports/reporter';
import type { AskQuestion } from './ports/dialog';
import { originFolder, type DataFolderPlugins } from './instance/loadOrderSnapshot';
import { DownloadsProvider } from './downloads/DownloadsProvider';
import { ImplicitMasterDecorationProvider } from './plugins/ImplicitMasterDecorationProvider';
import { makeRefreshAll } from './refreshAll';
import { ToolboxProvider } from './ToolboxProvider';
import { registerNameFilter, type NameFilter } from './nameFilter';
import { enterEditingAcrossRestarts } from './medit/backendStatus';
import { onPluginCheckboxChanged } from './pluginCheckboxHandler';
import { reconcilePlugins, reorderPlugins, setPluginEnabled, type ImplicitMasterSource, type PluginsCommandResult } from './pluginsCommands/plugins';
import { adoptMods } from './modlist/modlist';
import { registerModAdoption } from './modAdoptionTrigger';
import { registerPluginsReconcile } from './pluginsReconcileTrigger';
import { say, exitEditing } from './editingTeardown';
import { registerModInstallCommands, registerModContextCommands, registerSeparatorCommands, registerCreateEmptyModCommand, registerOverwriteView, registerModListCoreCommands } from './mods/modManagementCommands';
import { createModListView, registerDownloadsView, registerNotMo2InstanceWelcome } from './mo2TreeViews';
import { onModCheckboxChanged } from './mods/modCheckboxHandler';
import { collidingModName } from './mods/modNameCollision';
import { GAME_DIRECTORY_SECTION, gameDirectoryOverrides, setMo2InstanceContext } from './workspaceConfig';
import { registerToolboxCommands } from './toolboxCommands';
import { withPluginsViewProgress, type ExtensionSession, type Own } from './session';
import { registerRevealInExplorerCommand, registerCreatePluginCommand } from './plugins/pluginListCommands';

// The port members every gesture, the reconcile and the launch in this file call — narrowed off
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

/** The Toolbox: the view of the instance, and the MO2 side's composition root. Everything below
 *  `modbench.toolbox` in the container is built here and torn down with it. */
export interface Toolbox extends vscode.Disposable {
  /** Absent together, on the paths with no MO2 instance to read. Exposed for integration
   *  tests — production reaches all of these through the views. */
  modListProvider?: ModListProvider;
  downloadsProvider?: DownloadsProvider;
  pluginsTree?: PluginsTreeProvider;
  instance?: Instance;
  enterEditing?: () => Promise<void>;
}


async function applyOrThrow(command: Promise<PluginsCommandResult>): Promise<void> {
  const result = await command;
  if (!result.applied) throw new Error(result.refusal);
}

// The commands are free functions, so the composition root binds the instance root and the
// profile the Instance last landed, and turns a refusal into the rejection ADR-0019's
// notify-and-log path is written against.
function pluginListSource(instanceRoot: string, instance: Instance): PluginListSource {
  return {
    setPluginEnabled: (name, enabled) =>
      applyOrThrow(setPluginEnabled(instanceRoot, instance.value.activeProfile, name, enabled)),
    reorderPlugins: (names, drop) =>
      applyOrThrow(reorderPlugins(instanceRoot, instance.value.activeProfile, names, drop)),
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
function registerPluginsNameFilter(
  view: vscode.TreeView<PluginsTreeNode>, provider: PluginsTreeProvider,
): NameFilter {
  return registerNameFilter({
    view, viewId: 'modbench.pluginListTree', placeholder: 'Filter plugins…',
    setFilter: (text) => provider.setFilter(text),
    hasRows: async () => (await provider.getChildren()).length > 0,
  });
}


interface ReconcileDeps {
  session: ExtensionSession;
  instanceRoot: string;
  /** ADR-0013/ADR-0015: the snapshot is read from this, never from a walk of its own. */
  instance: Instance;
  /** ADR-0013: the one thing a snapshot is handed to. */
  sender: LoadOrderSender;
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

// ADR-0013: one landed Instance value becomes one snapshot; the client's sender owns what
// happens to it from there, and what comes back is reported and applied here.
function makeReconcile(deps: ReconcileDeps): () => Promise<void> {
  const {
    session, instanceRoot, instance, sender, client, recordBrowser, outputChannel,
    setStatusText, notifyConflictsComputed, reporter,
  } = deps;
  const run = async (): Promise<void> => {
    const snapshot = loadOrderSnapshotOf(instance.value);
    if (!snapshot) {
      outputChannel.info('[toolbox] no game directory resolved — there is no load order to hand mEdit');
      return;
    }
    const { plugins, dataFolder } = snapshot;
    const treeProgress = makeTreeProgressHandler(session);
    outputChannel.info(`[toolbox] handing mEdit the load order snapshot (${plugins.length} plugin copies)`);
    // The Index's own known refusal rides a tick, never the put's own outcome (ADR-0013) — this
    // is the only place it is seen, so it is checked on every one, not folded into treeProgress.
    const onProgress = (status: LoadOrderProgress): void => {
      reportIndexRefusal(status, { setStatusText });
      treeProgress.onProgress(status);
    };
    // A release the table can't translate is sent as MO2's own spelling rather than a guess: the
    // backend then rejects it visibly instead of quietly answering about the wrong game.
    const result = await sender.send({
      plugins,
      gameDirectory: dataFolder,
      instanceRoot,
      gameRelease: gameReleaseForGame(instance.value.gameRelease) ?? instance.value.gameRelease,
    }, { onProgress });
    await applyLoadOrderOutcome(plugins, result, treeProgress.lastFailures(), treeProgress.lastTotalPlugins(), {
      log: (m) => outputChannel.info(`[toolbox] ${m}`),
      warn: (m) => reporter.report('warning', m),
      error: (m) => reporter.report('error', m),
      setStatusText,
      refreshTree: () => recordBrowser.refresh(),
      notifyConflictsComputed,
      syncFilterState: () => applySyncedFilterState(client, session, outputChannel, reporter),
      applyReconciled: (failures, totalPlugins) => applyLoadOrderToTree(session, failures, outputChannel, reporter, totalPlugins),
    });
  };
  // A snapshot handed over before mEdit is attached waits on the client for the connect, so
  // narrating it would leave the Plugins view spinning on a load nobody has asked for yet.
  return () => (client.status === 'attached' ? withPluginsViewProgress(session, run) : run());
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
function makeTreeProgressHandler(session: ExtensionSession): {
  onProgress: (status: LoadOrderProgress) => void;
  lastTotalPlugins: () => number;
  /** The last tick's own failures — the PUT response carries none of its own (ADR-0019). */
  lastFailures: () => PluginLoadFailure[];
} {
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
  reconcile: () => Promise<void>;
}

// ADR-0002: owns its own progress indicator rather than leaving each caller to wrap it, and
// reports its steps through `say`.
function makeEnterEditing(deps: EnterEditingDeps): () => Promise<void> {
  const { session, instance, sender, client, outputChannel, reporter, revealLog, reconcile } = deps;
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
    await reconcile();
  };
  return () => withPluginsViewProgress(session, enter);
}


interface Mo2Side {
  instance: Instance;
  instanceRoot: string;
  modListProvider: ModListProvider;
  downloadsProvider: DownloadsProvider;
  pluginsTree: PluginsTreeProvider;
  refreshAll: () => Promise<void>;
  enterEditing: () => Promise<void>;
}

// Undefined on the two paths with no MO2 instance to read: no workspace folder, and a folder
// that is not one. Both leave the Toolbox view registered and row-less.
function buildMo2Side(own: Own, deps: ToolboxDeps): Mo2Side | undefined {
  const {
    outputChannel, session, client, recordBrowser, pluginFacts, loadDiagnostics,
    setStatusText, notifyConflictsComputed, reporterFor, ask,
  } = deps;
  // The flat log shim, for collaborators still taking a flat `(msg) => void`.
  const log = (msg: string) => outputChannel.info(msg);
  const instanceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!instanceRoot) {
    outputChannel.info('[toolbox] No workspace folder open — Mod List view not registered.');
    // Explicit, not left implicitly falsy: the viewsWelcome `when` clause also guards on VS Code's
    // own `workspaceFolderCount != 0`, but every exit path sets both keys rather than leaving one.
    setMo2InstanceContext(false);
    return undefined;
  }
  // An MO2 instance is the folder containing ModOrganizer.ini, mods/, and profiles/ — distinct
  // from a real instance with a genuinely unreadable/corrupt modlist, which still reports as an
  // error tree node (ADR-0019).
  if (!isMo2Instance(instanceRoot)) {
    own(registerNotMo2InstanceWelcome(instanceRoot, outputChannel));
    return undefined;
  }
  setMo2InstanceContext(true);
  const modListReporter = reporterFor('modList');
  // ADR-0015: the one Instance over MO2's files, recomputed from the instance directory and the
  // resolver MO2 files answers "where is the game" with.
  const instance = own(new Instance({
    instanceRoot, log, resolveGameDirectory: gameDirectoryResolver(gameDirectoryOverrides),
  }));
  // The Instance watches files only, so an edited setting is the root's to hand to the same
  // recompute Refresh's re-read runs; the Instance's own queue coalesces a burst.
  own(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration(GAME_DIRECTORY_SECTION)) void instance.refresh();
  }));
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
  const reconcile = makeReconcile({
    session, instanceRoot, instance, sender, client, recordBrowser, outputChannel,
    setStatusText, notifyConflictsComputed, reporter: reporterFor('loadOrder'),
  });
  // The backend answers this, never the extension (ADR-0016), and it needs both the Data folder
  // and the game. An unresolved folder, a game with no Mutagen release, and an unreachable
  // backend are one answer: unknown.
  const implicitMastersIn = (folder: string | undefined, gameName: string): Promise<string[] | undefined> =>
    implicitMastersFrom(client, folder, gameReleaseForGame(gameName));
  // plugins.txt converges on what disk provides; the write reaches the Plugins tree and Editing's
  // Plugin load order sync through the plugins.txt watcher.
  const runPluginsReconcile = async (
    profile: string, provided: ReadonlyMap<string, string>, inData: DataFolderPlugins,
    folder: string | undefined, gameName: string,
  ) => {
    const result = await reconcilePlugins(
      instanceRoot, profile, provided, inData, () => implicitMastersIn(folder, gameName),
      (msg) => outputChannel.debug(msg));
    if (!result.applied) {
      outputChannel.error(`[modmanager] Plugins reconcile failed: ${result.refusal}`);
      return;
    }
    if (result.append.length > 0) {
      outputChannel.info(`[modmanager] Plugins reconcile appended ${result.append.length} disabled plugins.txt line(s) for plugin(s) on disk with no line: ${result.append.join(', ')}`);
    }
    if (result.prune.length > 0) {
      outputChannel.info(`[modmanager] Plugins reconcile pruned ${result.prune.length} plugins.txt line(s) with no plugin on disk: ${result.prune.join(', ')}`);
    }
  };
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
      reporterFor(logLabel).report('error', failMessage, err instanceof Error ? err.message : String(err));
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
      revealLog: () => outputChannel.show(true), reconcile,
    }),
    (msg) => outputChannel.error(`[toolbox] ${msg}`),
  ));
  // ADR-0013: the one trigger for a PUT — a landed Instance recompute, never a gesture. A throw
  // in the applied outcome is logged here, because no caller is left to hear it.
  own(instance.subscribe(() => void reconcile().catch((e: unknown) => outputChannel.error(
    `[toolbox] handing mEdit the load order threw: ${e instanceof Error ? e.message : String(e)}`))));
  own(modListView.onDidChangeCheckboxState((e) =>
    onModCheckboxChanged(e, modListProvider, reporterFor('modList.checkbox'))));
  ownAll(own, registerModListCoreCommands(modListProvider));
  ownAll(own, registerToolboxCommands({
    instanceRoot, instance, outputChannel, updateProfileDescription, reporterFor, ask,
  }));
  ownAll(own, registerModInstallCommands({ instanceRoot, instance, runModAction, promptModName, warnIfFomod }));
  ownAll(own, registerModContextCommands(instanceRoot, instance, runModAction, ask));
  ownAll(own, registerSeparatorCommands(instanceRoot, instance, runModAction));
  own(registerCreateEmptyModCommand(instanceRoot, instance, runModAction));
  ownAll(own, registerOverwriteView(instance, reporterFor('overwrite.reveal')));
  own(registerModAdoption(
    instance, (profile, unlistedFolders) => adoptMods(instanceRoot, profile, unlistedFolders),
    () => modListProvider.invalidate(), outputChannel));
  own(registerPluginsReconcile(instance, runPluginsReconcile));
  const downloadsProvider = registerDownloadsView(own, instanceRoot, instance, reporterFor('downloadList'), ask, {
    nameNewMod: (defaultName) => promptModName(defaultName, (name) => collidingModName(instance, name)),
    warnIfFomod,
  });
  // ADR-0014: rebuild before resend before the tree re-reads (refreshAll.ts owns the sequence);
  // a rebuild failure is reported through the injected reporter, never a bare toast (modbench/CLAUDE.md).
  const refreshAll = makeRefreshAll({
    rebuildIndex: () => rebuildIndexVia(
      client, instanceRoot,
      (message, detail) => reporterFor('refresh').report('error', message, detail),
      gameReleaseForGame(instance.value.gameRelease) ?? instance.value.gameRelease,
    ),
    sendLoadOrder: () => reconcile(),
    // The Mods tree renders the Instance's value now (ADR-0015): force a real re-read of disk,
    // not just a re-render of whatever the Instance last landed.
    invalidateMods: () => { void instance.refresh(); modListProvider.invalidate(); },
    // Same as invalidateMods above: Plugins renders the Instance value too (ADR-0015).
    invalidatePlugins: () => { void instance.refresh(); pluginsTree.invalidate(); },
    // Same as invalidatePlugins above: Downloads renders the Instance value too (ADR-0015).
    invalidateDownloads: () => { void instance.refresh(); downloadsProvider.invalidate(); },
    updateProfileDescription,
  });
  return { instance, instanceRoot, modListProvider, downloadsProvider, pluginsTree, refreshAll, enterEditing };
}

const ownAll = (own: Own, disposables: vscode.Disposable[]): void => {
  for (const disposable of disposables) own(disposable);
};

export function createToolbox(deps: ToolboxDeps): Toolbox {
  const { client, reporterFor } = deps;
  const owned: vscode.Disposable[] = [];
  const own: Own = (disposable) => {
    owned.push(disposable);
    return disposable;
  };

  const mo2 = buildMo2Side(own, deps);

  // ADR-0015: the view's rows are the Instance's value. The provider holds no state and reads
  // no disk, so a landed recompute is the only thing that can change what it shows.
  const provider = new ToolboxProvider({
    state: () => (mo2 ? { activeProfile: mo2.instance.value.activeProfile, deployed: mo2.instance.value.deployed } : undefined),
  });
  own(vscode.window.createTreeView('modbench.toolbox', { treeDataProvider: provider }));
  if (mo2) own(mo2.instance.subscribe(() => provider.refresh()));
  // Its scope is the workspace, so it lives here rather than on any single tree — and it is only
  // the safety net for a flaky watcher, never the primary path.
  own(vscode.commands.registerCommand('modbench.refresh', async () => {
    await mo2?.refreshAll();
    provider.refresh();
  }));
  own(registerCreatePluginCommand(client, mo2, reporterFor('newPlugin')));

  return {
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

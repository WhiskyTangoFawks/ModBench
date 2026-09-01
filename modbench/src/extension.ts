import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as cp from 'child_process';
import { Agent, fetch as undiciFetch } from 'undici';
import { BackendManager } from './medit/BackendManager';
import { backendLogLevelArgs, makeBackendLogForwarder } from './medit/backendLog';
import { createApiClient, type MasterIssue, type CrashRepairOffer } from './medit/ApiClient';
import { detectWinePrefix } from './medit/GamePathDetector';
import { EditingController, type LoadOrderProgress } from './medit/EditingController';
import { makeReconcileProgressHandler } from './medit/loadOrderProgress';
import { PluginTreeNode, PluginTreeProvider, headerFormKeyFor, type RecordNode } from './medit/PluginTreeProvider';
import { ActiveRecordTracker } from './medit/ActiveRecordTracker';
import { resolveCompileTarget } from './medit/compileTarget';
import { ApiPluginRepository, type PluginRepository } from './medit/PluginRepository';
import { runRebase } from './medit/externalChangeCoordinator';
import { trackProgressMessage } from './medit/trackProgress';
import { FilterCodeLensProvider } from './medit/FilterCodeLensProvider';
import { ReferencedByTreeProvider } from './medit/ReferencedByTreeProvider';
import { broadcastToRecordPanels } from './medit/onRecordEdited';
import { EXTENSION_TO_WEBVIEW, type ColumnHeaderContext } from './medit/messages';
import { presentCrashRepairOffers } from './medit/crashRepairOffer';
import { Mo2ModlistSource } from './modmanager/mo2/Mo2ModlistSource';
import { isMo2Instance } from './modmanager/detectMo2Instance';
import { ModListProvider } from './modmanager/ModListProvider';
import { createModsWatcher } from './modmanager/modsWatcher';
import { createModlistWatcher } from './modmanager/modlistWatcher';
import { createPluginsTxtWatcher } from './modmanager/pluginsTxtWatcher';
import { PluginListProvider, pluginFileOf, orderIssueMastersOf, type PluginListNode } from './modmanager/PluginListProvider';
import { PluginsTreeComposite } from './PluginsTreeComposite';
import { createLoadOrderSync, type LoadOrderSync } from './loadOrderReconcile';
import { wirePluginListInvalidation } from './wirePluginListInvalidation';
import { createGameDirectoryResolver, dataFolderFrom, type GameDirectoryResolver } from './modmanager/gameDirectoryResolver';
import { isDeployed, type Reporter } from './modmanager/deployer';
import { buildFileConflictIndex } from './modmanager/fileConflictIndex';
import { buildLoadOrderSnapshot, type LoadOrderPlugin } from './modmanager/loadOrderSnapshot';
import { resolvePluginDestination, type PluginDestinationChoice } from './modmanager/pluginDestination';
import { DownloadsProvider } from './modmanager/DownloadsProvider';
import { ImplicitMasterDecorationProvider } from './modmanager/ImplicitMasterDecorationProvider';
import { makeReporter } from './reporter';
import { LoadoutHeaderProvider } from './LoadoutHeaderProvider';
import { registerNameFilter, type NameFilter } from './nameFilter';
import { onPluginCheckboxChanged } from './pluginCheckboxHandler';
import { registerEditorCommands, registerRecordLifecycleCommands, makeResolveOriginOrReport, runCopyRecordCommand, makeMergeEditorOpener, compileAndReport, reportCompileTargetError, registerHeldTrackedRepositories, refreshSourceControlFor, wireExternalChangePolling, type MinimalRepository } from './medit/editorCommands';
import { reconcileModlistWithModsDir } from './modmanager/startupModlistReconcile';
import { say, exitToLoadout, clearTreeWhenBackendDies, refreshMatchingPlugins } from './loadoutTeardown';
import { publishLoadDiagnoses, groupDiagnosesByPlugin } from './medit/loadDiagnostics';
import { registerModInstallCommands, registerModContextCommands, registerSeparatorCommands, registerOverwriteView, registerModsAutoRegisterWatcher, registerNotMo2InstanceWelcome, createModListView, registerDownloadsView, isStandaloneDeployment, registerDeploymentModeContext, registerDeployCommands, registerLaunchCommand, registerModListCoreCommands } from './modmanager/modManagementCommands';
import { onModCheckboxChanged } from './modmanager/modCheckboxHandler';
import { meditConfig, makeDetectPaths, setMo2InstanceContext } from './workspaceConfig';


/** Everything one `activate()` call constructs that a choke point registered elsewhere (a
 *  command, a watcher callback, a checkbox handler) also has to reach — `enterEditing`/
 *  `exitToLoadout`/`switchProfile` and friends. One object built empty in `activate()` and
 *  threaded to whatever registrar needs a field, rather than nine separate module-level
 *  singletons each carrying its own "why module level" paragraph — the reason was always the
 *  same one (a choke point outside `activate()`'s own closure needs it), so it is said once,
 *  here, instead of nine times. `undefined` until `activate()`'s own wiring reaches the field —
 *  every reader already treats "not yet built" and "no live workspace" the same way (`?.`). */
interface ExtensionSession {
  backendManager?: BackendManager;
  loadoutHeaderProvider?: LoadoutHeaderProvider;
  /** The merged Plugins tree. */
  pluginsTree?: PluginsTreeComposite<PluginListNode, PluginTreeNode>;
  /** ADR-0044: the one path by which the Plugin load order reaches Editing. */
  loadOrderSync?: LoadOrderSync;
  /** The same view, as a `TreeView` — carries the load's own progress and incompleteness
   *  statement (`TreeView.message`, via `say` below). */
  pluginsTreeView?: vscode.TreeView<PluginListNode | PluginTreeNode>;
  /** The same view's name filter — a second, independent narrowing axis from the record filter,
   *  which has to be able to add itself to this view's readout (`say` below). */
  pluginsNameFilter?: NameFilter;
  /** Plugin filename → the `vscode.git` `Repository` handle opened for that plugin's own mod
   *  folder — rebuilt wholesale by `registerHeldTrackedRepositories`, same "no stale carryover"
   *  posture as `loadOrderSync`'s own match map. Kept so a successful field edit can prompt the
   *  right repository's own `status()` and make the native Source Control panel pick up the
   *  resulting working-tree change without a manual Refresh click. */
  pluginRepositories?: Map<string, MinimalRepository>;
  /** The record browser behind the merged tree's children — mEdit starting/stopping is what
   *  tells its record rows which plugins are immutable (Remove hidden via `contextValue`). */
  recordBrowserProvider?: PluginTreeProvider;
  /** The record filter's single writer (the context key its Clear action is gated on, the code
   *  lens's active SQL, and the readout) — built by `makeSetFilterActive` alongside where this
   *  is assigned, exactly once. */
  setFilterActive?: ReturnType<typeof makeSetFilterActive>;
  /** #570: fetch the session-load Kind B scan and publish it (Problems panel + tree
   *  decoration). Assigned in activate() where the repository, the diagnostic collection and the
   *  instance root all exist; called by applyLoadOrderToTree after every reconcile's hand-off. */
  refreshDiagnoses?: () => void;
  /** #570: the same scan's Problems collection, held on the session so the teardown writers
   *  (loadoutTeardown.ts) can clear it alongside the tree badge. */
  loadDiagnostics?: vscode.DiagnosticCollection;
}


/** ADR-0035: run `work` with a progress indicator in the **Plugins view's own header**,
 *  addressed by view id. One indicator, in the view whose contents are being loaded, running for
 *  the whole operation — the backend spawn, the indexing, and the winner sweep, which the load
 *  POST only returns after. Not a per-command `ProgressLocation.Notification`: two indicators for
 *  one operation is noise. The header bar carries no text, so the step messages go to `say`
 *  above — one surface, one voice.
 *
 *  The message clears here, on every exit path including `work`'s own early returns and
 *  throws, so no failure can leave the view claiming a load that is not running.
 *
 *  Deliberately not `cancellable`: the header location has no cancel affordance (that is a
 *  Notification-only option), and abandoning a load is Close mEdit's job, not a second control. */
function withPluginsViewProgress(session: ExtensionSession, work: () => Promise<void>): Promise<void> {
  return Promise.resolve(vscode.window.withProgress(
    { location: { viewId: 'modbench.pluginListTree' } },
    async () => { try { await work(); } finally { say(session, undefined); } },
  ));
}

/** Which plugin files Editing's load order actually names — the backend's own
 *  list, not the snapshot we sent it, because the backend prepends the game's implicit masters and
 *  those are rows in the Plugins tree too — plus, of that set, which are read-only for editing
 *  (Editing's "Immutable plugin", `PluginMetadata.isImmutable`) and each plugin's own master
 *  issues (`PluginMetadata.masterIssues`, ADR-0037). Bundled as one fact, not three
 *  separate reads: all three come off the same `getPlugins()` call and are handed to
 *  `PluginsTreeComposite.setLoadOrder` together, so there is never a moment where a caller could
 *  have one without the others.
 *
 *  ADR-0044: `GET /plugins` lists every held copy, losing ones included, and two copies can share
 *  a filename; every map here is keyed by filename, so it reads the `inLoadOrder` copy — the one
 *  plugins.txt names, which is the one a tree row stands for. */
interface HeldPluginFiles {
  files: Set<string>;
  readOnly: Set<string>;
  masterIssues: Map<string, MasterIssue[]>;
  /** ADR-0035 amending ADR-0018: lowercased filename → does this plugin own at least one
   *  record the *current* record filter matches. Carried in the same hand-off, for the same
   *  reason as `masterIssues` — this call already asked `GET /plugins` the question, and every
   *  reconcile reaches it downstream of `EditingController.syncFilterState()`
   *  (`createReconcileSequencer`'s own sequence, shared by Launch mEdit, the crash-restart handler
   *  and every snapshot the sync sends), so this is the one hand-off through which the filter
   *  state the backend actually has — not the one an earlier `setFilter`/`clearFilter` last left
   *  behind — reaches `loadOrderSync`'s match map. That is what keeps the map from outliving the
   *  state it describes. */
  matches: Map<string, boolean>;
}

function heldPluginFilesFrom(repository: ApiPluginRepository): () => Promise<HeldPluginFiles> {
  return async () => {
    const plugins = (await repository.getPlugins()).filter((p) => p.inLoadOrder);
    return {
      files: new Set(plugins.map((p) => p.name)),
      readOnly: new Set(plugins.filter((p) => p.isImmutable).map((p) => p.name)),
      // ADR-0037: `masterIssues` is a required, non-nullable array on the wire, so it is read
      // straight through — the `?? []` that used to sit here was compensating for a schema that
      // described every field as optional (#627), not for anything the backend can actually do.
      masterIssues: new Map(plugins.map((p) => [p.name, p.masterIssues] as const)),
      matches: new Map(plugins.map((p) => [p.name.toLowerCase(), p.hasMatchingRecords] as const)),
    };
  };
}


/** Everything that follows the record filter turning on or off: the context key its Clear
 *  action is gated on, the code lens's notion of which SQL is live, and the Plugins
 *  tree's readout — where the record filter is one of two independent narrowing axes and is
 *  named by its *source*, never by its SQL, because a `WHERE` clause is not a readout. `SQL` is
 *  the honest fallback for a filter read back off the backend when it comes up, whose source
 *  this frontend never saw.
 *
 *  The single writer for all three, called with `false` and nothing else by exitToLoadout
 *  to end the record filter's UI state when mEdit closes, the same way EditingController's own
 *  setFilter/clearFilter/syncFilterState call it while it runs. `modbench.filterActive` is written
 *  from exactly this one place. */
function makeSetFilterActive(session: ExtensionSession, filterProvider: FilterCodeLensProvider) {
  return (active: boolean, sql?: string, label?: string) => {
    void vscode.commands.executeCommand('setContext', 'modbench.filterActive', active);
    filterProvider.setActiveSql(active ? (sql ?? null) : null);
    session.pluginsNameFilter?.setBaseDescription(active ? `records: ${label ?? 'SQL'}` : undefined);
  };
}


/** The backend launches with the extension — maintainer ruling 2026-09-01: the DB-file-backed
 *  session made startup cheap enough that lifecycle stopped being a user decision, so the
 *  Launch mEdit / Close mEdit commands are gone. The extension still owns spawn/teardown
 *  (ADR-0022): spawn is here at activation (only in an MO2 instance — enterEditing exists
 *  only when the loadout views registered), teardown is deactivate()/crash handling.
 *  exitToLoadout survives as the failure path, same as the old command's own catch. A launch
 *  that bailed for want of a game directory (enterEditing's 'no-game-directory' teardown)
 *  gets its retry when the user supplies one — with no Launch command left, a config change
 *  is the only gesture that can mean "try again". */
function wireAutoLaunch(
  session: ExtensionSession, context: vscode.ExtensionContext, outputChannel: vscode.LogOutputChannel,
  enterEditing: (() => Promise<void>) | undefined,
): void {
  const reporter = makeReporter(outputChannel, 'launch');
  const launch = async () => {
    try {
      await enterEditing?.();
    } catch (err) {
      exitToLoadout(session); // reset the view and tear down any half-started backend
      reporter.report('error', 'Failed to launch mEdit.', err instanceof Error ? err.message : String(err));
    }
  };
  void launch();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('modbench.mods.gameDirectory') && !session.backendManager?.isHealthy) void launch();
    }),
  );
}

export function activate(context: vscode.ExtensionContext) {
  // Everything a choke point registered elsewhere (a command, a watcher, a checkbox handler)
  // has to reach back into — see ExtensionSession's own doc comment. Built empty and filled in
  // as this function's own wiring reaches each field.
  const session: ExtensionSession = {};
  activeSession = session; // deactivate()'s only way to reach it — see activeSession's own comment.
  const port: number = meditConfig().get('backendPort') ?? 5172;

  const outputChannel = vscode.window.createOutputChannel('Modbench', { log: true });
  context.subscriptions.push(outputChannel);
  // `log` is a compat shim (defaults to .info) for modules taking a flat `(msg) => void`.
  const log = (msg: string) => outputChannel.info(msg);

  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  context.subscriptions.push(statusBarItem);
  // Save & Compile's diagnostics — one collection for every tracked mod's source files, kept
  // current per compile (publishCompileDiagnostics replaces a mod's own entries wholesale each run).
  const compileDiagnostics = vscode.languages.createDiagnosticCollection('modbench-compile');
  context.subscriptions.push(compileDiagnostics);
  // #570: the session-load Kind B scan's own collection — a sibling of the compile one,
  // targeting plugin binaries (pre-Track), replaced wholesale per scan (publishLoadDiagnoses).
  const loadDiagnostics = vscode.languages.createDiagnosticCollection('modbench-diagnosis');
  context.subscriptions.push(loadDiagnostics);
  session.loadDiagnostics = loadDiagnostics;
  session.backendManager = createBackendManager(port, outputChannel, statusBarItem);

  const client = createApiClient(port, createUnlimitedFetch());
  const repository = new ApiPluginRepository(client, log);
  const treeProvider = new PluginTreeProvider(repository, log);
  session.recordBrowserProvider = treeProvider;
  const openPanels = new Map<string, vscode.WebviewPanel>();
  const recordPanels = new Set<vscode.WebviewPanel>();
  // The Referenced By view's input — which record panel is active and what FormKey it shows.
  const activeRecordTracker = new ActiveRecordTracker<vscode.WebviewPanel>();
  const { scriptsPath, filterProvider } = setupScripts(meditConfig());

  session.setFilterActive = makeSetFilterActive(session, filterProvider);

  const controller = new EditingController({
    client,
    repository,
    log,
    refreshTree: () => treeProvider.refresh(),
    setStatusText: (t) => { statusBarItem.text = t; },
    showWarning: (msg) => { void vscode.window.showWarningMessage(msg); },
    showError: (msg) => { void vscode.window.showErrorMessage(msg); },
    setFilterActive: session.setFilterActive,
    refreshMatchingPlugins: () => { void refreshMatchingPlugins(session, repository, outputChannel); },
    // Fires on every completed reconcile: tells every open record panel to refetch its
    // comparison, and (re-)registers every tracked mod's repo with `vscode.git`.
    notifyConflictsComputed: () => {
      broadcastToRecordPanels(recordPanels, { type: EXTENSION_TO_WEBVIEW.CONFLICTS_COMPUTED });
      // ADR-0041: the load order just settled — the one reliable point to (re-)register every
      // tracked mod's repo with vscode.git.
      void registerHeldTrackedRepositories(repository, outputChannel, (repos) => { session.pluginRepositories = repos; });
    },
  });
  // The "Referenced By" tree — provider + view construction. Lives in the Panel container
  // (package.json) and retargets on `activeRecordTracker`'s active-record changes rather than an
  // explicit command — `showFor` is wired here, once, rather than at every command call site. The
  // onCountChanged callback below closes over `referencedByTreeView` before its own `const` line
  // runs — safe because VS Code never calls getChildren (and so never invokes the callback) until
  // createTreeView returns and this whole function has finished, by which point the const is long
  // since initialized.
  const referencedByTreeProvider = new ReferencedByTreeProvider(client, log, (count) => {
    // The declared name is "Plugins - Referenced By" — the sub-functionality
    // naming convention (ADR-0035) — and the runtime count badge carries the same prefix so the
    // title keeps it once a count is known.
    referencedByTreeView.title = count === undefined ? 'Plugins - Referenced By' : `Plugins - Referenced By (${count})`;
  });
  const referencedByTreeView = vscode.window.createTreeView('modbench.referencedByTree', {
    treeDataProvider: referencedByTreeProvider,
    canSelectMany: true,
  });
  const activeRecordSubscription = activeRecordTracker.onDidChangeActiveRecord(
    (formKey) => referencedByTreeProvider.showFor(formKey));
  // Primes the view with whatever activeRecordTracker already knows — a no-op today (this runs
  // before any openRecordPanel call ever exists to make a panel active), but it's what makes
  // ActiveRecordTracker.current()'s own "initial state" contract true rather than aspirational,
  // and guards the construction order above ever changing.
  referencedByTreeProvider.showFor(activeRecordTracker.current());
  // Composes the loud crash-repair offer sequence over Save & Compile's existing tail
  // (`compileAndReport`). Run once per completed reconcile (`makeEnterEditing`'s own call site),
  // never a poller: see `crashRepairOffer.ts`'s own doc comment for why a reconcile is the only
  // moment either offer reason can newly arise.
  const showCrashRepairOffers = (offers: CrashRepairOffer[]) => presentCrashRepairOffers(
    offers,
    (message, options, ...buttons) => Promise.resolve(vscode.window.showWarningMessage(message, options, ...buttons)),
    (offer, atRef) => compileAndReport(
      controller, compileDiagnostics, { name: offer.plugin, origin: offer.origin }, atRef, repository,
    ),
  );
  const { modListProvider, downloadsProvider, pluginListProvider, modlistSource, instanceRoot, enterEditing } = registerLoadoutSurfaces(session, { context, outputChannel, controller, recordBrowser: treeProvider, heldPluginFiles: heldPluginFilesFrom(repository), showCrashRepairOffers });
  // #570: ADR-0026 background tier — the scan is advisory, so a blip logs and retries next
  // reconcile, never toasts. Fire-and-forget: the tree hand-off must not wait on a
  // whole-load-order file scan.
  let diagnosisScanGeneration = 0;
  session.refreshDiagnoses = () => {
    // No instance root means no MO2 workspace — nothing a diagnosis could point at.
    if (instanceRoot === undefined) return;
    // Generation guard: a slow scan answering after a newer reconcile's own refresh (or after
    // teardown cleared everything) must not resurrect a stale answer.
    const generation = ++diagnosisScanGeneration;
    void repository.getDiagnoses().then((reports) => {
      if (generation !== diagnosisScanGeneration) return;
      publishLoadDiagnoses(loadDiagnostics, instanceRoot, reports);
      session.pluginsTree?.setDiagnoses(groupDiagnosesByPlugin(reports));
    }).catch((err: unknown) => {
      outputChannel.warn(`[extension] the malformed-plugin scan could not be read: ${err instanceof Error ? err.message : String(err)}`);
    });
  };
  wireExternalChangePolling(repository, controller, outputChannel,
    (cb) => session.backendManager!.on('status', cb), () => session.backendManager!.isHealthy);
  context.subscriptions.push(
    referencedByTreeView,
    activeRecordSubscription,
    vscode.languages.registerCodeLensProvider({ language: 'sql' }, filterProvider),
    ...registerPluginRowCommands(session, controller, repository, activeRecordTracker, outputChannel, compileDiagnostics),
    registerCreatePluginCommand(controller, modlistSource, instanceRoot, pluginListProvider, outputChannel),
    ...registerEditorCommands({
      context, openPanels, recordPanels, activeRecordTracker, port, treeProvider, controller, repository, scriptsPath, referencedByTreeView, outputChannel,
      mergedTreeSelection: () => session.pluginsTreeView?.selection ?? [],
      refreshMatchingPlugins: () => { void refreshMatchingPlugins(session, repository, outputChannel); },
      refreshSourceControlFor: (plugin) => refreshSourceControlFor(session.pluginRepositories, plugin, outputChannel),
    }),
  );

  statusBarItem.text = '$(plug) mEdit';

  wireAutoLaunch(session, context, outputChannel, enterEditing);

  // Exposed for integration tests — unused in production. loadOrderSync/backendManager: #650's
  // matchingPlugins tests need to observe/drive the real singletons directly (the match map has
  // no other externally observable surface, and a live "backend went unhealthy outside
  // exitToLoadout" needs the real BackendManager.stop()), same reasoning as every other field here.
  return {
    modListProvider, downloadsProvider, pluginListProvider, pluginsTree: session.pluginsTree, pluginListView: session.pluginsTreeView, treeProvider,
    outputChannel, enterEditing, exitToLoadout: () => exitToLoadout(session), loadOrderSync: session.loadOrderSync, backendManager: session.backendManager,
  };
}


interface PluginListDeps {
  session: ExtensionSession;
  modlistSource: Mo2ModlistSource;
  outputChannel: vscode.LogOutputChannel;
  reporter: Reporter;
  instanceRoot: string;
  // A getter through the single game-directory resolver, not a Promise settled once —
  // see ModListProviderOptions/PluginListProviderOptions for why. Folds a resolution failure to
  // undefined (degrading vanilla-master lookups/badges).
  dataFolder: () => Promise<string | undefined>;
  /** The record browser that supplies a plugin row's children. Passed as the composite's
   *  child source and never touched directly here. */
  recordBrowser: PluginTreeProvider;
}
/** The Plugins tree: a view of plugins.txt, stacked below the Mods tree. A row's checkbox toggles
 *  its enabled state (writing plugins.txt immediately); rows drag-and-drop to reorder (single or
 *  multi-select, writing plugins.txt immediately); a title-bar Refresh forces a re-read.
 *  `instanceRoot` enables the order-aware missing-master badge.
 *
 *  ADR-0035: the view is a `PluginsTreeComposite` over two providers — these rows and
 *  the record browser's children — so that with the backend running each row expands into its
 *  records. The composite is built here, at the composition root, because it is the only place
 *  that may know both; `PluginListProvider` is unchanged and still owns everything about a row. */
function registerPluginListView(deps: PluginListDeps): { pluginListProvider: PluginListProvider; disposables: vscode.Disposable[] } {
  const { session, modlistSource, outputChannel, reporter, instanceRoot, dataFolder, recordBrowser } = deps;
  // `log` is a compat shim (defaults to .info) for modules taking a flat `(msg) => void` —
  // constructed here, at the boundary, rather than threaded in as its own PluginListDeps field
  // alongside outputChannel (#628: finishing the reporter migration means the flat shape stops
  // at the collaborator that still needs it, not one level higher).
  const log = (msg: string) => outputChannel.info(msg);
  const pluginListProvider = new PluginListProvider({ source: modlistSource, log, reporter, instanceRoot, dataFolder });
  // The Plugins tree's own `PluginsTreeComposite` construction. ADR-0035: the view is a
  // `PluginsTreeComposite` over two providers — these rows and the record browser's children — so
  // that with the backend running each row expands into its records. Built here, at the
  // composition root, because it is the only place that may know both; `PluginListProvider` is
  // unchanged and still owns everything about a row.
  const composite = new PluginsTreeComposite<PluginListNode, PluginTreeNode>({
    rows: pluginListProvider,
    // A thin positional adapter, not `recordBrowser` passed directly — the composite's own
    // `getPluginChildren(pluginFile)` contract has no `origin` slot (a root row never has one to
    // give), while `PluginTreeProvider.getPluginChildren` keeps its `(name, origin?)` shape: that
    // is how Editing browses a registered losing copy by origin (ADR-0044) — data kept
    // available while nothing in this view displays it.
    children: {
      getPluginChildren: (file) => recordBrowser.getPluginChildren(file),
      getChildren: (child) => recordBrowser.getChildren(child),
      getTreeItem: (child) => recordBrowser.getTreeItem(child),
      onDidChangeTreeData: recordBrowser.onDidChangeTreeData,
    },
    pluginFileOf,
    // ADR-0037: lets the composite reconcile the order-aware badge with load order state
    // by master name, instead of two decorations that can disagree.
    orderIssueMastersOf,
    // ADR-0035 amending ADR-0018: the match map is refreshed off the module-level
    // refreshMatchingPlugins function above, whenever EditingController's setFilter/clearFilter
    // run. Undefined (never fetched, or the accessor finds nothing for this file) reads as
    // "matches" — the composite's own fallback for an accessor that has nothing to say.
    hasMatchingRecords: (file) => session.loadOrderSync?.matches(file.toLowerCase()),
  });
  session.pluginsTree = composite;
  clearTreeWhenBackendDies(session, composite, recordBrowser);
  const pluginListView = vscode.window.createTreeView('modbench.pluginListTree', {
    treeDataProvider: composite,
    canSelectMany: true,
    // Still the row provider's: a drag moves plugins.txt lines, which is a Mod-Management
    // concern whether or not the rows happen to have children today.
    dragAndDropController: pluginListProvider,
    // Title-bar rule 7 (modbench/CLAUDE.md): hierarchical trees get Collapse All, and this one
    // is hierarchical — plugin → record type → record.
    showCollapseAll: true,
  });
  session.pluginsTreeView = pluginListView; // see its declaration — progress and message live here
  session.pluginsNameFilter = registerPluginsNameFilter(pluginListView, pluginListProvider);
  // `modbench.pluginListTree.revealInExplorer`. Registered here, ahead of the
  // registerFileDecorationProvider/wireLoadOrderWatchers/onDidChangeCheckboxState calls below (it
  // used to run after them, as one more element of the same return array) — hoisted out so its
  // body isn't inline inside that array literal. Its disposal position in that array is
  // unchanged; only the moment `vscode.commands.registerCommand` itself fires moved slightly
  // earlier, against independent, unrelated registrations it shares no dependency with.
  const revealReporter = makeReporter(outputChannel, 'pluginListTree.revealInExplorer');
  const revealInExplorerCommand = vscode.commands.registerCommand('modbench.pluginListTree.revealInExplorer', async (node: PluginListNode) => {
    if (node?.kind !== 'plugin') return;
    const name = node.plugin.name;
    const filePath = await pluginListProvider.resolvePluginPath(name);
    if (!filePath) {
      // ADR-0026: an explicit user action failed — notify + log, never a silent no-op.
      revealReporter.report('error', `Could not resolve a file location for "${name}".`);
      return;
    }
    try {
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(filePath));
    } catch (err) {
      revealReporter.report('error', `Failed to reveal "${name}" in Explorer.`, err instanceof Error ? err.message : String(err));
    }
  });
  return { pluginListProvider, disposables: [
    pluginListView,
    composite,
    // Grays an implicit master's row the way MO2 grays COL_NAME for a forceLoaded
    // plugin (ImplicitMasterDecorationProvider's own comment) — keyed off the same
    // dataFolder this view already resolves, live against PluginListProvider's own
    // implicitMasterNames() so it never drifts from what the tree actually rendered.
    vscode.window.registerFileDecorationProvider(
      new ImplicitMasterDecorationProvider(dataFolder, () => pluginListProvider.implicitMasterNames()),
    ),
    ...wireLoadOrderWatchers(session.loadOrderSync!, instanceRoot, pluginListProvider),
    pluginListView.onDidChangeCheckboxState((e) => onPluginCheckboxChanged(e, pluginListProvider, outputChannel)),
    revealInExplorerCommand,
    // ADR-0044: the checkbox gesture's other half — the participation change
    // `PluginListProvider.setPluginEnabled` just wrote to `plugins.txt` is the next snapshot, sent
    // through the same coalescing sync every other loadout gesture uses. The plugins.txt watcher
    // would fire for the same write; asking explicitly as well makes the gesture's own path not
    // depend on a watcher event, and the sync folds the two into one PUT. The sync itself drops
    // the request when no backend is receiving — Mod Management works with no backend running,
    // and that is the ordinary case, not a failure to report.
    pluginListProvider.onDidChangeParticipation(() => session.loadOrderSync?.request()),
    session.pluginsNameFilter,
  ] };
}

/** Every plugin-row command (Track, Save & Compile, compile-at-ref, Rebase, the record
 *  lifecycle and copy gestures) — one shared concern, the Plugins-tree row's own context menu,
 *  as distinct from the record editor's own commands (`registerEditorCommands`, one level up). */
function registerPluginRowCommands(
  session: ExtensionSession,
  controller: EditingController,
  repository: ApiPluginRepository,
  activeRecordTracker: ActiveRecordTracker<vscode.WebviewPanel>,
  outputChannel: vscode.LogOutputChannel,
  compileDiagnostics: vscode.DiagnosticCollection,
): vscode.Disposable[] {
  // Shared by the lifecycle and copy commands below — a node's own `origin` when the row already
  // carries it (ADR-0036), else `controller.resolveOrigin`; reports and returns undefined when
  // neither answers (there is no ambient fallback worth a QuickPick, which is why every command
  // that needs this is palette-gated).
  const resolveOriginOrReport = makeResolveOriginOrReport(controller, outputChannel);
  return [
    registerTrackCommand(
      session, controller, outputChannel,
      () => registerHeldTrackedRepositories(repository, outputChannel, (repos) => { session.pluginRepositories = repos; }),
    ),
    registerSaveAndCompileCommand(controller, repository, activeRecordTracker, outputChannel, compileDiagnostics),
    registerCompileAtRefCommand(controller, repository, outputChannel, compileDiagnostics),
    registerRebaseCommand(controller, repository, outputChannel),
    ...registerRecordLifecycleCommands(controller, repository, outputChannel),
    // xEdit parity (xeMainForm.pas's CopyInto, reached from both mniNavCopyIntoClick — the
    // tree row — and mniViewHeaderCopyIntoClick — the column header): one command per gesture,
    // registered once, reached from either entry point. `arg` is a plugins-tree RecordNode or the
    // column header's own ColumnHeaderContext (its data-vscode-context payload) — resolved to the
    // same {formKey, plugin, origin} identity either way (recordCopyIdentity), so everything past
    // that point is one implementation path regardless of which row was right-clicked.
    vscode.commands.registerCommand('modbench.record.copyAsOverride', async (arg?: RecordNode | ColumnHeaderContext) => {
      await runCopyRecordCommand('copy-as-override', arg, controller, repository, resolveOriginOrReport, outputChannel);
    }),
    vscode.commands.registerCommand('modbench.record.copyAsNewRecord', async (arg?: RecordNode | ColumnHeaderContext) => {
      await runCopyRecordCommand('copy-as-new', arg, controller, repository, resolveOriginOrReport, outputChannel);
    }),
    registerOpenHeaderCommand(),
  ];
}

// Reaches every plugin-bearing merged-tree row (modmanager's PluginListNode, not medit's own
// PluginNode) via pluginFileOf() — the same row-agnostic adapter the composite already uses.
// A join, not an Editing-only gesture (its argument is Mod Management's own row type), so it
// lives alongside the other plugin-row commands above rather than in registerRecordViewCommands
// with the rest of the record panel's own commands.
function registerOpenHeaderCommand(): vscode.Disposable {
  return vscode.commands.registerCommand('modbench.openHeader', (node?: PluginListNode) => {
    const pluginName = node && pluginFileOf(node);
    if (!pluginName) return;
    void vscode.commands.executeCommand('modbench.openEditor', {
      formKey: headerFormKeyFor(pluginName), label: pluginName,
    });
  });
}

/** ADR-0041: the Track gesture. Resolves the clicked row's plugin name to the mod folder the
 *  load order actually loaded it from, asks which `.gitignore` preset to generate (Edits is the
 *  default — Everything is the opt-in authoring choice), then delegates the HTTP call to
 *  `EditingController`. `onTracked` re-registers the native SCM panel for the newly tracked repo
 *  immediately, without waiting for the next activation.
 *
 *  A mega-plugin's complete serialization is a one-time, worst-case
 *  tens-of-seconds cost (ADR-0041), so the whole `track` call runs under the same Plugins-view
 *  progress indicator already built for the other long, blocking-POST operation this view
 *  has (the reconcile) — same surface, same `say` narration, no second bespoke indicator. */
function registerTrackCommand(
  session: ExtensionSession, controller: EditingController, outputChannel: vscode.LogOutputChannel, onTracked: () => Promise<void>,
): vscode.Disposable {
  return vscode.commands.registerCommand('modbench.pluginListTree.track', async (node: PluginListNode) => {
    if (node?.kind !== 'plugin') return;
    const name = node.plugin.name;
    const origin = await controller.resolveOrigin(name);
    if (!origin) {
      // ADR-0026: an explicit user action failed — notify + log, never a silent no-op.
      makeReporter(outputChannel, 'pluginListTree.track').report('error', `Could not resolve which mod "${name}" belongs to.`);
      return;
    }

    const choice = await vscode.window.showQuickPick(
      [
        { label: 'Edits', description: 'Source only — recommended for downloaded mods' },
        { label: 'Everything', description: 'Source + assets — for authoring a mod from scratch' },
      ],
      { placeHolder: `Track "${name}" — what should its .gitignore include?` },
    );
    if (!choice) return;

    await withPluginsViewProgress(session, async () => {
      say(session, trackProgressMessage(origin, { phase: 'Idle', pluginsDone: 0, pluginsTotal: 0 }));
      const ok = await controller.track(origin, choice.label as 'Edits' | 'Everything', {
        // Narrates the same Plugins-view message this
        // command already showed a static version of, updated on each poll tick.
        onProgress: (status) => say(session, trackProgressMessage(origin, status)),
      });
      if (!ok) return;
      void vscode.window.showInformationMessage(`Modbench: Tracked "${origin}".`);
      await onTracked();
    });
  });
}

/** ADR-0041: New Plugin's destination QuickPick — the composition root joining both
 *  bounded contexts in one gesture (precedent: `makeEnterEditing`). `overwrite/` is listed first
 *  so it is the QuickPick's pre-highlighted default (`showQuickPick` has no `activeItem` option;
 *  array order is the only way to pre-highlight, same convention `modbench.vmad.setScriptFlags`
 *  already uses) — Enter alone accepts it, preserving the xEdit-under-MO2 reflex. "New mod…"
 *  creates the mod folder itself via `installMod` with an empty source dir before returning, so it
 *  registers in `modlist.txt` and the Mods tree the same way any other install does — free, not
 *  reinvented. Returns undefined if the user cancels any prompt. */
async function pickPluginDestination(
  modlistSource: Mo2ModlistSource, instanceRoot: string,
): Promise<{ path: string; origin: string } | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      { label: 'overwrite/', description: "MO2's overwrite folder", choice: { kind: 'overwrite' } as PluginDestinationChoice },
      { label: 'Existing mod…', choice: { kind: 'existingMod' } as const },
      { label: 'New mod…', choice: { kind: 'newMod' } as const },
    ],
    { placeHolder: 'Where should the new plugin live?' },
  );
  if (!picked) return undefined;

  if (picked.choice.kind === 'overwrite') return resolvePluginDestination(instanceRoot, picked.choice);

  if (picked.choice.kind === 'existingMod') {
    const entries = await modlistSource.readModlist();
    const modNames = entries.filter((e) => e.kind === 'mod').map((e) => e.name);
    const modName = await vscode.window.showQuickPick(modNames, { placeHolder: 'Which mod?' });
    return modName ? resolvePluginDestination(instanceRoot, { kind: 'existingMod', modName }) : undefined;
  }

  const modName = await vscode.window.showInputBox({ prompt: 'New mod name' });
  if (!modName) return undefined;
  const staging = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'medit-newmod-'));
  try {
    // Accepted residue, the frontend's twin of PluginEndpoints.CreatePlugin's own
    // GitUnavailableException-catch comment: the mod folder is registered here, before the create
    // POST below even runs. If that POST then fails, the mod stays registered — empty and
    // disabled, same as any fresh install — rather than being rolled back. Visible in the Mods
    // tree, harmless, and the user's own delete-the-mod-folder undoes it; deliberately not
    // engineered around.
    await modlistSource.installMod(modName, staging, {});
  } finally {
    await fs.promises.rm(staging, { recursive: true, force: true });
  }
  return resolvePluginDestination(instanceRoot, { kind: 'newMod', modName });
}

/** ADR-0041: `modbench.newPlugin` — creation lands as tracked working-tree text. Editing's
 *  create endpoint writes the file, Tracks the destination if needed, and indexes it; only once
 *  that has actually succeeded does Mod Management's own writer (`appendPlugin`) add the load-order
 *  line — never the other way around, so the load order can never name a file that doesn't yet
 *  exist. Registered unconditionally (the command exists in every activation), but needs a live
 *  Loadout to have anywhere to put the plugin — the Plugins tree it's contributed to
 *  (`modbench.pluginListTree`) only renders with one anyway, so the guard below is defensive, not
 *  the normal path. */
// Kept apart from registerCreatePluginCommand because the load-order append and its own
// failure mode (created but unregistered — a real, surfaced state, not silently dropped) is one
// coherent step.
async function appendCreatedPluginToLoadOrder(
  modlistSource: Mo2ModlistSource, pluginListProvider: PluginListProvider, pluginName: string, outputChannel: vscode.LogOutputChannel,
): Promise<void> {
  try {
    await modlistSource.appendPlugin(pluginName);
  } catch (err) {
    makeReporter(outputChannel, 'newPlugin').report(
      'error',
      `Created "${pluginName}", but could not add it to the load order — add it manually in the Plugins tree.`,
      err instanceof Error ? err.message : String(err),
    );
    pluginListProvider.invalidate();
    return;
  }
  pluginListProvider.invalidate();
  void vscode.window.showInformationMessage(`Modbench: Created "${pluginName}".`);
}

function registerCreatePluginCommand(
  controller: EditingController,
  modlistSource: Mo2ModlistSource | undefined,
  instanceRoot: string | undefined,
  pluginListProvider: PluginListProvider | undefined,
  outputChannel: vscode.LogOutputChannel,
): vscode.Disposable {
  const reporter = makeReporter(outputChannel, 'newPlugin');
  return vscode.commands.registerCommand('modbench.newPlugin', async () => {
    if (!modlistSource || !instanceRoot || !pluginListProvider) {
      reporter.report('error', 'New Plugin needs an open MO2 instance workspace.');
      return;
    }

    const name = await promptPluginName();
    if (!name) return;

    let destination: { path: string; origin: string } | undefined;
    try {
      destination = await pickPluginDestination(modlistSource, instanceRoot);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      reporter.report('error', `Could not prepare the destination — ${message}`);
      return;
    }
    if (!destination) return; // user cancelled a prompt

    // EditingController.createPlugin already surfaces its own failure (ADR-0026) — nothing more
    // to do here than stop.
    const created = await controller.createPlugin(name, destination.path, destination.origin);
    if (!created) return;

    await appendCreatedPluginToLoadOrder(modlistSource, pluginListProvider, created.name, outputChannel);
  });
}


/** `Modbench: Rebase onto Updated Baseline` — origin-scoped (the repo, not any one plugin,
 *  is the unit of baselines and rebase), resolved from a tracked plugin row the same way Track
 *  resolves origin. Also the *re-runnable* form: {@link SourceRepository.RebaseEditBranch}'s own
 *  resumption-aware design means this same command both starts a rebase and resumes one left
 *  conflicted after the user resolves it in the native merge editor. */
function registerRebaseCommand(
  controller: EditingController, repository: PluginRepository, outputChannel: vscode.LogOutputChannel,
): vscode.Disposable {
  return vscode.commands.registerCommand('modbench.pluginListTree.rebase', async (node?: PluginListNode) => {
    if (node?.kind !== 'plugin') return;
    const name = node.plugin.name;
    const origin = await controller.resolveOrigin(name);
    if (!origin) {
      makeReporter(outputChannel, 'pluginListTree.rebase').report('error', `Could not resolve which mod "${name}" belongs to.`);
      return;
    }

    const result = await runRebase({ controller, openMergeEditor: makeMergeEditorOpener(repository, outputChannel) }, origin);
    if (!result) return; // transport failure already surfaced by EditingController

    if (result.outcome === 'Refused') {
      void vscode.window.showWarningMessage(`Modbench: ${result.refusalReason ?? 'Rebase refused.'}`);
    } else if (result.outcome === 'Clean') {
      void vscode.window.showInformationMessage(`Modbench: Rebased "${origin}" onto the updated baseline.`);
    } else {
      void vscode.window.showWarningMessage(
        `Modbench: Rebasing "${origin}" hit conflicts — resolve them in the opened merge editor(s), ` +
          'then run "Modbench: Rebase onto Updated Baseline" again to continue.',
      );
    }
  });
}

/** Save & Compile — reachable from a tracked plugin row's context menu (`node` given), the
 *  record editor's title-bar icon (compiles the *active* record's owning plugin — never an
 *  unfiltered QuickPick, which risks compiling the wrong plugin in a
 *  multi-mod load order), and the command palette (QuickPick fallback only when neither a tree row nor
 *  an active record is in hand — see `resolveCompileTarget` in `./medit/compileTarget` for the exact
 *  order). */
function registerSaveAndCompileCommand(
  controller: EditingController,
  repository: PluginRepository,
  activeRecordTracker: ActiveRecordTracker<vscode.WebviewPanel>,
  outputChannel: vscode.LogOutputChannel,
  diagnostics: vscode.DiagnosticCollection,
): vscode.Disposable {
  return vscode.commands.registerCommand('modbench.saveAndCompile', async (node?: PluginListNode) => {
    const target = await resolveCompileTarget(
      node?.kind === 'plugin' ? node.plugin.name : undefined,
      activeRecordTracker.current(),
      {
        resolveOrigin: (name) => controller.resolveOrigin(name),
        getRecordOwner: (formKey) => repository.getRecordOwner(formKey),
        onError: (message) => reportCompileTargetError(outputChannel, 'saveAndCompile', message),
        pickPlugin: async () => {
          const plugins = await repository.getPlugins();
          const choice = await vscode.window.showQuickPick(
            plugins.map((p) => ({ label: p.name, description: p.origin })),
            { placeHolder: 'Save & Compile which plugin?' },
          );
          if (!choice) return undefined;
          if (!choice.description) {
            reportCompileTargetError(outputChannel, 'saveAndCompile', `"${choice.label}" has no mod folder to compile into.`);
            return undefined;
          }
          return { name: choice.label, origin: choice.description };
        },
      },
    );
    if (!target) return;

    await compileAndReport(controller, diagnostics, target, undefined, repository);
  });
}

/** Compiling at `main` (no checkout — the edit branch and its dirt are untouched) writes
 *  the binary as `main` has it, behind one confirmation that names the ref literally, never
 *  "pristine" (no stored mode, ADR-0041 amendment) — a Modified workflow's pristine restore and an
 *  Authored workflow's release rebuild are the same gesture, and neither is this command's business
 *  to tell apart. Tree-row only (unlike Save & Compile itself): naming a ref to compile at from the
 *  palette with no plugin in hand isn't a gesture worth a QuickPick, so `pickPlugin` here is a no-op
 *  (`resolveCompileTarget`'s third tier never fires without a tree row). */
function registerCompileAtRefCommand(
  controller: EditingController, repository: PluginRepository,
  outputChannel: vscode.LogOutputChannel, diagnostics: vscode.DiagnosticCollection,
): vscode.Disposable {
  return vscode.commands.registerCommand('modbench.pluginListTree.compileAtMain', async (node?: PluginListNode) => {
    if (node?.kind !== 'plugin') return;
    const target = await resolveCompileTarget(node.plugin.name, undefined, {
      resolveOrigin: (name) => controller.resolveOrigin(name),
      getRecordOwner: () => Promise.resolve(undefined),
      onError: (message) => reportCompileTargetError(outputChannel, 'compileAtMain', message),
      pickPlugin: () => Promise.resolve(undefined),
    });
    if (!target) return;

    const confirmed = await vscode.window.showWarningMessage(
      `Compile "${target.name}" at ref "main"?`,
      {
        modal: true,
        detail: `This overwrites the binary with what "main" holds, without touching your edit branch. ` +
          `Your working-tree changes stay exactly where they are.`,
      },
      'Compile at main',
    );
    if (confirmed !== 'Compile at main') return;

    await compileAndReport(controller, diagnostics, target, 'main', repository);
  });
}

/** ADR-0044: the sync every loadout gesture feeds — see `loadOrderReconcile.ts`. Builds both
 *  halves of one reconcile pipeline from Mod Management's and Editing's own types, none of which
 *  cross into either module: the coalescing/debounce wrapper (`createLoadOrderSync`) and, folded
 *  into it, the reconcile's own steps (`createReconcileSequencer`) — arm, resolve the game
 *  directory, build the snapshot, PUT, apply, present crash-repair offers. Every reconcile runs
 *  under the Plugins view's own header progress indicator (`withPluginsViewProgress`), the same
 *  surface a launch uses. It receives only while the backend is up: with none, a request is
 *  dropped silently, since a loadout-only workspace is the ordinary case. 250 ms of debounce
 *  covers the bursts that matter — the modlist and mods watchers both firing for one install, a
 *  drag reorder's own write plus its watcher event, a checkbox toggle's explicit request plus the
 *  plugins.txt event it causes. */
function makeLoadOrderSync(deps: ReconcileDeps): LoadOrderSync {
  const { session, instanceRoot, modlistSource, controller, outputChannel, heldPluginFiles, showCrashRepairOffers, gameDirResolver } = deps;
  return createLoadOrderSync<LoadOrderPlugin, LoadOrderProgress, CrashRepairOffer>({
    isReceiving: () => session.backendManager?.isHealthy === true,
    debounceMs: 250,
    log: (msg) => outputChannel.debug(msg),
    withProgress: (work) => withPluginsViewProgress(session, work),
    say: (message) => say(session, message),
    logInfo: (msg) => outputChannel.info(msg),
    notifyNoGameDirectory: () => void vscode.window.showErrorMessage(
      'Modbench: No game directory found. Set modbench.mods.gameDirectory to your Stock Game Folder or Steam install.',
    ),
    // gameDirResolver's own `null` ("resolved, but there is none") and the sequencer's own
    // `undefined` ("nothing to build a snapshot from") are the same fact; normalized at the one
    // seam between them rather than teaching the sequencer a second falsy spelling.
    resolveGameDirectory: () => gameDirResolver.resolve().then((gd) => gd ?? undefined),
    buildSnapshot: (dataFolder) => buildLoadOrderSnapshot(modlistSource, instanceRoot, dataFolder, (entries, root) =>
      buildFileConflictIndex(entries, root, (msg) => outputChannel.debug(msg))),
    makeProgressHandler: () => makeTreeProgressHandler(session),
    putLoadOrder: (plugins, dataFolder, signal, onProgress) =>
      controller.putLoadOrder(plugins, dataFolder, instanceRoot, undefined, { onProgress, signal }),
    syncFilterState: () => controller.syncFilterState(),
    applyReconciled: (failures, totalPlugins) => applyLoadOrderToTree(session, heldPluginFiles, failures, outputChannel, totalPlugins),
    presentCrashRepairOffers: (offers) => showCrashRepairOffers(offers),
  });
}


/** ADR-0044: what keeps Editing's load order true — Mod Management's own reactive watchers, never
 *  a timer (modbench/CLAUDE.md: reactive over manual). Every event is "recompute the snapshot, PUT
 *  it", coalesced by the sync, so these three watchers plus the two explicit asks (a checkbox
 *  toggle, a profile switch) are the whole of the wiring — there is no command downstream of them.
 *
 *  Three watchers because one does not cover every gesture. `modlist.txt` is rewritten by
 *  install, uninstall *and* reprioritise, so it catches all three on the Mod axis; `mods/**`
 *  catches a folder appearing or vanishing without a `modlist.txt` write, which is what a
 *  hand-dropped or hand-deleted mod folder looks like before auto-registration notices it;
 *  `plugins.txt` is the Plugin axis — a reorder or an enable/disable, whether Modbench wrote it or
 *  MO2/the user did (root CLAUDE.md: never assume exclusive ownership of a file on disk).
 *
 *  Each passes `debounceMs: 0` — #621's mechanism 2: `sync.request()` already debounces every
 *  arrival on its own, so a second, uncoordinated wait in front of it (fsWatcher.ts's own
 *  historical 200ms) only adds latency without adding coalescing, since the sync's single timer
 *  is what every arrival, from whichever watcher, actually resets. Cuts the latency on this path
 *  from ~450ms to ~250ms.
 *
 *  #653: the same three signals also drive the Plugins tab's own row provider — until this,
 *  nothing did, so an external plugins.txt change (MO2, another tool, a hand edit) left the tab
 *  stale until a manual Refresh. `wirePluginListInvalidation` adds that second consumer onto
 *  each signal alongside `sync.request()`, never in place of it (unit-tested on its own,
 *  `src/test/wirePluginListInvalidation.test.ts`, since this composition root has no seam of
 *  its own). */
function wireLoadOrderWatchers(
  sync: LoadOrderSync, instanceRoot: string, pluginListProvider: PluginListProvider,
): vscode.Disposable[] {
  const events = wirePluginListInvalidation(
    { onModsChange: () => sync.request(), onModlistChange: () => sync.request(), onPluginsChange: () => sync.request() },
    pluginListProvider,
  );
  return [
    sync,
    createModlistWatcher(instanceRoot, events.onModlistChange, 0),
    createModsWatcher(instanceRoot, events.onModsChange, 0),
    createPluginsTxtWatcher(instanceRoot, events.onPluginsChange, 0),
  ];
}

/** The merged Plugins tree's name filter — the axis that narrows *which plugin rows*
 *  appear, composing with (never replacing) the record filter's axis over which records appear
 *  under an expanded row. An error row survives every filter by design (ADR-0026), so it counts
 *  as content here: a view showing the reason its list is wrong must not also claim the term
 *  matched nothing. */
function registerPluginsNameFilter(
  view: vscode.TreeView<PluginListNode | PluginTreeNode>, provider: PluginListProvider,
): NameFilter {
  return registerNameFilter({
    view, viewId: 'modbench.pluginListTree', placeholder: 'Filter plugins…',
    setFilter: (text) => provider.setFilter(text),
    hasRows: async () => (await provider.getChildren()).length > 0,
  });
}


/** The Loadout half of activation, as one step: deployment-mode context key, the
 *  Mods/Plugins/Downloads views, and the header that sits above them. Split out of `activate`
 *  because these three are one wiring concern — and because the header must register even on
 *  the paths where `registerLoadoutView` bails (no workspace, or not an MO2 instance): it is
 *  the container's first view and must never be a hole. Returns what the integration tests
 *  read off `activate`'s exports. */
function registerLoadoutSurfaces(session: ExtensionSession, deps: Omit<LoadoutViewDeps, 'revealLog'>): {
  modListProvider?: ModListProvider; downloadsProvider?: DownloadsProvider; pluginListProvider?: PluginListProvider;
  // Forwarded so the composition root can wire modbench.newPlugin's destination QuickPick —
  // both are undefined together with the providers above, on the same no-workspace/not-an-MO2-
  // instance paths registerLoadoutView already bails on.
  modlistSource?: Mo2ModlistSource; instanceRoot?: string; enterEditing?: () => Promise<void>;
} {
  const { context, outputChannel } = deps;
  registerDeploymentModeContext(context, () => session.loadoutHeaderProvider?.refresh());
  const loadout = registerLoadoutView(session, { ...deps, revealLog: () => outputChannel.show(true) });
  registerLoadoutHeaderView(session, { context, outputChannel, ...loadout });
  return {
    modListProvider: loadout?.modListProvider,
    downloadsProvider: loadout?.downloadsProvider,
    pluginListProvider: loadout?.pluginListProvider,
    modlistSource: loadout?.modlistSource,
    instanceRoot: loadout?.instanceRoot,
    enterEditing: loadout?.enterEditing,
  };
}


interface LoadoutViewDeps {
  context: vscode.ExtensionContext;
  outputChannel: vscode.LogOutputChannel;
  revealLog: () => void;
  controller: EditingController;
  /** The record browser the Plugins tree's rows expand into. Threaded from `activate`,
   *  which owns the single instance both plugin trees read through. */
  recordBrowser: PluginTreeProvider;
  /** The plugin files the backend's load order names, for deciding which rows can expand.
   *  Injected as a getter so the composite's own wiring stays at the composition root. */
  heldPluginFiles: () => Promise<HeldPluginFiles>;
  /** Run the loud crash-repair offer sequence for whatever a completed reconcile found.
   *  Composed once at the composition root (activate()), where the diagnostics collection and
   *  compileAndReport's own compile door already live. */
  showCrashRepairOffers: (offers: CrashRepairOffer[]) => Promise<void>;
}
/** Register the Loadout (Mod List) view and its commands. Returns the live
 *  ModListProvider and DownloadsProvider (exposed via activate() for integration
 *  tests), or undefined with a neutral log when no workspace is open, or when the
 *  workspace isn't an MO2 instance (the Mods view shows welcome content instead). */
// A crash-restart is a fresh backend, so the reconcile has to run again from scratch — the same
// re-entry path a fresh Launch takes, not a bespoke recovery. Pulled out of registerLoadoutView so
// that function's own body stays about *building* the views, not also about what happens after
// one of their dependencies restarts.
function wireEnterEditingOnRestart(
  session: ExtensionSession, enterEditing: () => Promise<void>, outputChannel: vscode.LogOutputChannel,
): void {
  session.backendManager!.on('restarted', () => {
    void enterEditing().catch((err: unknown) =>
      outputChannel.error(`[extension] reload after backend restart failed: ${err instanceof Error ? err.message : String(err)}`),
    );
  });
}

function registerLoadoutView(session: ExtensionSession, deps: LoadoutViewDeps): { modListProvider: ModListProvider; downloadsProvider: DownloadsProvider; pluginListProvider: PluginListProvider; modlistSource: Mo2ModlistSource; instanceRoot: string; refreshAll: () => void; enterEditing: () => Promise<void> } | undefined {
  const { context, outputChannel, revealLog, controller, recordBrowser, heldPluginFiles, showCrashRepairOffers } = deps;
  // #628: the flat log shim, built locally rather than threaded in as its own Deps field.
  const log = (msg: string) => outputChannel.info(msg);
  const instanceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!instanceRoot) {
    outputChannel.info('[extension] No workspace folder open — Mod List view not registered.');
    // Explicit, not left implicitly falsy — the viewsWelcome `when` clause
    // also guards on VS Code's own `workspaceFolderCount != 0`, so neither key's value
    // actually matters with no workspace open, but every exit path sets both rather than
    // leaving a fourth, implicit "never set" state.
    setMo2InstanceContext(false);
    return undefined;
  }
  // An MO2 instance is the folder containing ModOrganizer.ini, mods/, and
  // profiles/ — distinct from a real instance with a genuinely unreadable/corrupt
  // modlist, which still reports as an error tree node (ADR-0026).
  if (!isMo2Instance(instanceRoot)) {
    registerNotMo2InstanceWelcome(instanceRoot, context, outputChannel);
    return undefined;
  }
  setMo2InstanceContext(true);
    const modListReporter = makeReporter(outputChannel, 'modList');
    const modlistSource = new Mo2ModlistSource(instanceRoot, log, modListReporter);
    // The single GameDirectory resolver (config override → ini gamePath → autodetect),
    // memoised and invalidated only when modbench.mods.gameDirectory changes — the one thing every
    // consumer of the game directory (these views, the load-order snapshot, deploy)
    // reads through, so none of them can disagree about which folder is current. Deliberately not
    // an activation-scoped Promise resolved once: that would freeze the folder for the life of
    // the window regardless of later edits to the setting.
    const gameDirResolver = createGameDirectoryResolver(instanceRoot, meditConfig, makeDetectPaths(), detectWinePrefix, vscode.workspace.onDidChangeConfiguration);
    // Non-blocking (keeps registration synchronous) and never rejects — a null resolution or a
    // misconfigured explicit setting both fold to undefined, so the consumers degrade exactly as
    // before (empty vanilla masters, badges absent). A rejection is re-thrown by every other
    // consumer of `gameDirResolver` directly; only the views degrade to undefined.
    // `dataFolderFrom` memoises the fold (and its error log) by the resolver's own cache
    // generation, so a stuck-broken setting logs once — `ImplicitMasterDecorationProvider` alone
    // reads this once per visible file, and a naive `.then()/.catch()` per call would re-log on
    // every one of those reads instead of once for the life of the resolution.
    const dataFolder = dataFolderFrom(gameDirResolver, (e) =>
      outputChannel.error(`[extension] resolving the game directory failed: ${e instanceof Error ? e.message : String(e)}`));
    const modListProvider = new ModListProvider({ source: modlistSource, log, instanceRoot, reporter: modListReporter, dataFolder });
    // ADR-0044: the one path by which the Plugin load order reaches Editing. Built here, before
    // the Plugins tree, because both the tree (its own hasMatchingRecords accessor) and
    // enterEditing below need the session slot filled first.
    session.loadOrderSync = makeLoadOrderSync({
      session, instanceRoot, modlistSource, controller, outputChannel, heldPluginFiles, showCrashRepairOffers, gameDirResolver,
    });
    const { pluginListProvider, disposables: pluginListDisposables } =
      registerPluginListView({ session, modlistSource, outputChannel, reporter: makeReporter(outputChannel, 'pluginList'), instanceRoot, dataFolder, recordBrowser });
    const { modListView, modListFilter, updateProfileDescription } =
      createModListView(modListProvider, modlistSource, outputChannel);
    // The three closures registerModInstallCommands needs, named for what's already true at
    // the call site, where they're handed to it as one bundle.
    const runModAction = async (logLabel: string, failMessage: string, action: () => Promise<void>) => {
      try {
        await action();
        modListProvider.invalidate();
      } catch (err) {
        makeReporter(outputChannel, logLabel).report('error', failMessage, err instanceof Error ? err.message : String(err));
      }
    };
    const promptModName = (defaultName: string) => vscode.window.showInputBox({ prompt: 'Mod name', value: defaultName });
    const warnIfFomod = (name: string, isFomod: boolean) => {
      if (isFomod)
        void vscode.window.showWarningMessage(
          `Modbench: "${name}" is a FOMOD installer — its files were copied as-is and need manual ` +
            `arrangement (the scripted installer is coming later).`,
        );
    };
    const enterEditing = makeEnterEditing(session, outputChannel, revealLog);
    wireEnterEditingOnRestart(session, enterEditing, outputChannel);
    context.subscriptions.push(
      modListView,
      modListFilter,
      modListView.onDidChangeCheckboxState((e) => onModCheckboxChanged(e, modListProvider, outputChannel)),
      ...registerModListCoreCommands(
        modListProvider, modlistSource, updateProfileDescription,
        () => session.loadoutHeaderProvider?.refresh(), () => session.loadOrderSync?.request(),
      ),
      ...registerDeployCommands(
        instanceRoot, modlistSource, outputChannel, gameDirResolver, () => session.loadoutHeaderProvider?.refresh(),
      ),
      registerLaunchCommand(outputChannel),
      gameDirResolver,
      ...registerModInstallCommands({ modlistSource, runModAction, promptModName, warnIfFomod }),
      ...registerModContextCommands(instanceRoot, modlistSource, outputChannel, runModAction),
      ...registerSeparatorCommands(modlistSource, runModAction),
      ...registerOverwriteView(instanceRoot, modListProvider, outputChannel),
      registerModsAutoRegisterWatcher(instanceRoot, modlistSource, modListProvider, outputChannel),
      ...pluginListDisposables,
    );
    // #93: the watcher above only covers changes made while Modbench runs; this one-time
    // pass reconciles what happened while it wasn't (folders added or deleted outside).
    void reconcileModlistWithModsDir(modlistSource, () => modListProvider.invalidate(), outputChannel);
    const { downloadsProvider, disposables: downloadsDisposables } = registerDownloadsView(instanceRoot, outputChannel);
    context.subscriptions.push(...downloadsDisposables);
    const refreshAll = makeRefreshAll(modListProvider, pluginListProvider, downloadsProvider, updateProfileDescription);
    return { modListProvider, downloadsProvider, pluginListProvider, modlistSource, instanceRoot, refreshAll, enterEditing };
}

/** Refresh is one need, not three. Every Mod-Management source re-reads from disk
 *  together — a partial refresh is the state where the user believes they have resynced and
 *  one tree still quietly disagrees with the others. */
function makeRefreshAll(
  modListProvider: ModListProvider,
  pluginListProvider: PluginListProvider,
  downloadsProvider: DownloadsProvider,
  updateProfileDescription: () => Promise<void>,
): () => void {
  return () => {
    modListProvider.invalidate();
    pluginListProvider.invalidate();
    downloadsProvider.invalidate();
    void updateProfileDescription();
  };
}

interface LoadoutHeaderDepsWiring {
  context: vscode.ExtensionContext;
  outputChannel: vscode.LogOutputChannel;
  /** Absent when no workspace is open or it isn't an MO2 instance — the header still
   *  registers (it is the container's first view and must never be a hole), it just has
   *  no profile to read. */
  modlistSource?: Mo2ModlistSource;
  /** Absent for the same reason as `modlistSource`; without it there is nothing to be
   *  deployed, so the deployment row stays absent regardless of the configured mode. */
  instanceRoot?: string;
  /** Re-reads every Mod-Management source. Absent when there is nothing to read. */
  refreshAll?: () => void;
}
/** The Loadout header view — workspace-scope readout and action home. Wired here, at
 *  the composition root, because it spans both bounded contexts; the provider itself takes
 *  only getters and knows about neither. */
function registerLoadoutHeaderView(session: ExtensionSession, deps: LoadoutHeaderDepsWiring): void {
  const { context, outputChannel, modlistSource, instanceRoot, refreshAll } = deps;
  const provider = new LoadoutHeaderProvider({
    hasLoadout: () => modlistSource !== undefined,
    activeProfile: async () => {
      if (!modlistSource) return undefined;
      try {
        return await modlistSource.getActiveProfile();
      } catch (err) {
        // ADR-0026 background tier: a readout blip degrades to an em-dash inline, not a toast —
        // and WARN, not ERROR: the system is coping, nothing the user asked for has failed.
        outputChannel.warn(`[extension] reading the active profile for the header failed: ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
      }
    },
    deployment: async () => {
      if (!isStandaloneDeployment() || !instanceRoot) return 'external';
      return (await isDeployed(instanceRoot)) ? 'deployed' : 'notDeployed';
    },
  });
  session.loadoutHeaderProvider = provider;
  context.subscriptions.push(
    vscode.window.createTreeView('modbench.loadoutHeader', { treeDataProvider: provider }),
    // The one Refresh, replacing the three each tree had grown. Its scope is the workspace,
    // so it lives here rather than on any single tree — and it is still only the safety net
    // for a flaky watcher, never the primary path.
    vscode.commands.registerCommand('modbench.refresh', () => {
      refreshAll?.();
      provider.refresh();
    }),
  );
  // The header's rows (profile, deployment) read no backend/load order state — the
  // mEdit row lives on the Plugins view — so there is nothing here for a backend status
  // transition to invalidate.
}


/** The completed reconcile's whole hand-off to the tree: which plugins the load order names, which
 *  are read-only for editing, each one's master issues and each one's open failure.
 *
 *  ADR-0035: rows gain chevrons here — and *finish* gaining them here. A
 *  progressive reconcile's ticks carry only the indexed set and the failures, because read-only
 *  state and master issues are whole-load-order derivations a partial one cannot answer; this is
 *  the call that fills them in. **A tick must never be the last word** — if one were, both those
 *  decorations would silently vanish from a fully reconciled tree.
 */
async function applyLoadOrderToTree(
  session: ExtensionSession,
  heldPluginFiles: () => Promise<HeldPluginFiles>,
  failures: { name?: string | null; reason?: string | null }[],
  outputChannel: vscode.LogOutputChannel,
  // The backend's own reported plugin count (the last poll's `LoadOrderStatus.totalPlugins`,
  // via `makeTreeProgressHandler`'s `lastTotalPlugins()`) — carried in only so this can be logged
  // next to what actually reached the tree, not because this function needs it for anything else.
  // Deliberately not `plugins.length` from the caller's own snapshot: that list is every copy
  // the frontend sent, and omits the implicit masters the backend prepends, so comparing against
  // it would read every healthy reconcile as short.
  totalPlugins: number,
): Promise<void> {
  try {
    const held = await heldPluginFiles();
    // This is the one line standing between a stuck-tail reconcile and a diagnosable one —
    // do not remove it as logging noise. `totalPlugins` is the backend's own count; `failures` is
    // what the reconcile already reported as unopenable or unindexable, so a plugin counted there
    // is accounted for, not missing. `held.files.size + failures.length` should land close to
    // `totalPlugins` for an ordinary reconcile — a gap bigger than that, or a reconcile that
    // otherwise reaches "load order ready" with no line at all, is what points at this hand-off
    // rather than at something upstream (most likely the backend's own `GET /plugins`).
    outputChannel.info(
      `[extension] applying reconciled load order to tree: ${held.files.size} in the load order, ${failures.length} failed, of ${totalPlugins} copies`,
    );
    // ADR-0037: the same failures the toast inside putLoadOrder already consumed —
    // held here (not re-derived, not a second endpoint) and handed to the tree through the same
    // setLoadOrder bundle as everything else the reconcile reports.
    const loadFailures = new Map(failures.map((f) => [f.name ?? '?', f.reason ?? 'Unknown error'] as const));
    // ADR-0035 amending ADR-0018: set before setLoadOrder fires its re-render, so no row
    // renders off a match set stale from whatever reconcile preceded this one — every reconcile
    // re-runs this exact hand-off.
    session.loadOrderSync?.setMatches(held.matches);
    session.pluginsTree?.setLoadOrder(held.files, held.readOnly, held.masterIssues, loadFailures);
    // The same read-only set, to the record rows — theirs is contextValue (Remove
    // hidden), the plugin rows' is the tooltip note.
    session.recordBrowserProvider?.setImmutablePlugins(held.readOnly);
    // #570: every reconcile re-runs the malformed-plugin scan — setLoadOrder above just cleared
    // the previous scan's decorations, and this brings the new answer when it lands.
    session.refreshDiagnoses?.();
  } catch (err) {
    // Leaving every row a leaf is a safe *render*, but it is not an honest one: the reconcile
    // did land, so the tree would be telling the user editing is unavailable when it is
    // available, with nothing on screen to say why. ADR-0026 integrity tier — notify, don't
    // just log.
    const message = err instanceof Error ? err.message : String(err);
    outputChannel.error(`[extension] reading the backend's plugin list failed; plugin rows will not expand: ${message}`);
    void vscode.window.showWarningMessage(
      'Modbench: The load order was reconciled, but the plugin list could not be read — plugin rows will not expand into records. Close and relaunch mEdit to retry.',
    );
  }
}

/** The line every abandoned check point used to get for free from `armLoadAbort`'s own
 *  `abandoned()` closure, back when arming lived here. Now that `loadOrderSync.arm()` returns a
 *  pure check (it cannot hold an `outputChannel` — ADR-0044's "no VS Code types in the interface"),
 *  each call site logs explicitly instead; same message, same one-shot-per-abandonment call count,
 *  since a reconcile returns as soon as the first check point notices. */
function reportAbandoned(outputChannel: vscode.LogOutputChannel): void {
  outputChannel.info('[extension] the reconcile was abandoned before it landed; leaving the closed view alone');
}

/** The progressive-reconcile tick handler, wired to this extension's own surfaces. Whether a
 *  tick is worth applying is decided in `medit/loadOrderProgress.ts` and unit-tested there; this
 *  supplies the hand-off itself, the only part that needs VS Code types. The empty read-only and
 *  master-issue arguments mid-reconcile are deliberate — see `makeReconcileProgressHandler`.
 *
 *  Also remembers each tick's own `totalPlugins`. That is the backend's count (implicit
 *  masters included, since the backend prepends them before this is ever reported) — a different,
 *  larger number than the frontend's own snapshot (`plugins.length` in `reconcile()` below),
 *  which never includes them. `applyLoadOrderToTree`'s completion log needs something to compare
 *  its own count against; a tick already carries the right number, and it does not change over
 *  the reconcile, so the last one seen is as good as asking again. */
function makeTreeProgressHandler(
  session: ExtensionSession,
): { onProgress: (status: LoadOrderProgress) => void; lastTotalPlugins: () => number } {
  let totalPlugins = 0;
  const applyTick = makeReconcileProgressHandler({
    applyLoadOrder: (indexedPlugins, failures) => session.pluginsTree?.setLoadOrder(
      new Set(indexedPlugins),
      new Set(),
      new Map(),
      new Map(failures.map((f) => [f.name, f.reason] as const)),
    ),
  });
  return {
    onProgress: (status) => { totalPlugins = status.totalPlugins; applyTick(status); },
    lastTotalPlugins: () => totalPlugins,
  };
}

interface ReconcileDeps {
  session: ExtensionSession;
  instanceRoot: string;
  modlistSource: Mo2ModlistSource;
  controller: EditingController;
  outputChannel: vscode.LogOutputChannel;
  /** The plugin files the backend's load order names — read once a reconcile lands, to
   *  decide which rows can expand. */
  heldPluginFiles: () => Promise<HeldPluginFiles>;
  /** Run once a reconcile completes, for whatever crash-repair offers it reported. */
  showCrashRepairOffers: (offers: CrashRepairOffer[]) => Promise<void>;
  /** The single game-directory resolver, shared with the views — memoised and invalidated
   *  only when modbench.mods.gameDirectory changes, so a snapshot always agrees with what they
   *  currently show. */
  gameDirResolver: GameDirectoryResolver;
}

/** Build the enter-editing action: spawn/attach the backend, then send it the load order. Also the
 *  crash-restart path.
 *
 *  ADR-0035: owns its own progress indicator (`withPluginsViewProgress` — see there)
 *  rather than leaving each of its callers to wrap it, and reports its steps through `say`. */
function makeEnterEditing(
  session: ExtensionSession, outputChannel: vscode.LogOutputChannel, revealLog: () => void,
): () => Promise<void> {
  const enter = async (): Promise<void> => {
    const { abandoned } = session.loadOrderSync!.arm();
    revealLog(); // the launch can take a while; let the user watch the step log
    say(session, 'Starting backend…');
    outputChannel.info('[extension] entering editing: starting backend');
    await session.backendManager!.start();
    // Before the health gate, deliberately: a close stops the backend, so an abandoned launch
    // would otherwise fail this check and report the stop it asked for as a startup failure.
    if (abandoned()) { reportAbandoned(outputChannel); return; }
    if (!session.backendManager!.isHealthy) {
      exitToLoadout(session); // tear down the half-started backend and reset the view
      void vscode.window.showErrorMessage('Modbench: Backend failed to start — see the Modbench output for details.');
      return;
    }
    // No game directory means nothing to build a snapshot from, so nothing for the backend to
    // hold — don't strand the UI in an empty editing view. `flush()` — not a separately threaded
    // reconcile function — is the activation path's own documented reason to exist: it wants the
    // outcome, not just a promise that a send will happen eventually.
    if ((await session.loadOrderSync!.flush()) === 'no-game-directory') exitToLoadout(session);
  };
  return () => withPluginsViewProgress(session, enter);
}


/** Undici's default Agent times out a fetch with no response bytes after ~300s
 *  (headersTimeout/bodyTimeout). The backend's blocking endpoints — PUT /load-order chief among
 *  them — legitimately run for minutes on a large load order, and every such call
 *  already carries its own deliberate abort signal where one is wanted, so nothing
 *  else should time it out. 0 disables both.
 *
 *  Bound per-request via `ApiClient`'s own `fetch` override, not `undici.setGlobalDispatcher` —
 *  tried first, and confirmed *not* to reach the actual outgoing request from inside the
 *  extension host (VS Code's own network stack sits in front of the ambient global `fetch`;
 *  the global dispatcher override never took effect there, only in a bare Node process). This
 *  bypasses that entirely by calling undici's own `fetch` directly, dispatcher attached to each
 *  call.
 *
 *  Can't just forward openapi-fetch's `Request` object straight through: it's built with the
 *  *global* `Request` constructor, a distinct class from undici's own internal one, and undici's
 *  `fetch` only recognizes its own — handed a global `Request`, it falls back to coercing it to a
 *  URL string and fails with "Failed to parse URL from [object Request]". Unpacked into a plain
 *  url/method/headers/body call instead. Lives here, not in ApiClient.ts: that module is also
 *  imported by the webview bundle (RecordPanelClient.ts), which has no `undici`/Node runtime.
 *
 *  `input.signal` is part of that unpacking too, deliberately — it is the *other* half of
 *  the "own deliberate abort signal" this comment already promises above (the mid-load
 *  close). Dropping it here silently disconnects that abort from the network layer: the caller's
 *  `AbortController.abort()` still flips `signal.aborted`, but nothing downstream ever rejects
 *  the fetch on it, so the abandoned reconcile just runs to completion for nobody. If a future
 *  rewrite unpacks this request shape again, carry `signal` with it. */
function createUnlimitedFetch(): (input: Request) => Promise<Response> {
  const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
  return async (input) => {
    const hasBody = input.method !== 'GET' && input.method !== 'HEAD';
    const body = hasBody ? await input.clone().arrayBuffer() : undefined;
    return undiciFetch(input.url, { method: input.method, headers: [...input.headers], body, dispatcher, signal: input.signal });
  };
}

/** Construct the editing backend manager wired to the bundled binary + status bar. */
function createBackendManager(port: number, channel: vscode.LogOutputChannel, statusBarItem: vscode.StatusBarItem): BackendManager {
  // Bundled backend binary (see build:backend / .vscodeignore). __dirname is
  // out/ at runtime; the published self-contained executable lives in backend/.
  const backendExe = process.platform === 'win32' ? 'MEditService.Api.exe' : 'MEditService.Api';
  return new BackendManager({
    port,
    log: (msg) => channel.info(msg),
    // Pipe the backend's Serilog console output into the same channel,
    // at its own level. Only applies to a backend we spawn — an attached
    // dev-launched one still logs to its own terminal.
    onOutput: makeBackendLogForwarder(channel),
    // Make the backend's Serilog minimum level follow the channel's
    // level at spawn time, so raising the channel to Debug/Trace actually
    // surfaces backend lines at that level instead of just louder frontend
    // ones. Read fresh per spawn (crash-restart picks up any level change);
    // never applied when attaching to an already-running backend.
    serilogLevelArgs: () => backendLogLevelArgs(channel.logLevel),
    executablePath: path.join(__dirname, '..', 'backend', backendExe),
    spawn: (exe, args) => cp.spawn(exe, args, { detached: false, stdio: ['ignore', 'pipe', 'pipe'] }),
    statusBar: {
      setText: (t) => { statusBarItem.text = t; },
      show: () => statusBarItem.show(),
      dispose: () => statusBarItem.dispose(),
    },
  });
}

/** Resolve the scripts dir (config or ~/.medit/scripts), seed the preset filter,
 *  and build the filter CodeLens provider over it. */
function setupScripts(cfg: vscode.WorkspaceConfiguration): { scriptsPath: string; filterProvider: FilterCodeLensProvider } {
  // Resolve scripts path (config or ~/.medit/scripts)
  const scriptsPathCfg: string = cfg.get('scriptsPath') ?? '';
  const scriptsPath = scriptsPathCfg || path.join(os.homedir(), '.medit', 'scripts');
  fs.mkdirSync(scriptsPath, { recursive: true });

  const filterProvider = new FilterCodeLensProvider(scriptsPath);
  return { scriptsPath, filterProvider };
}


// VS Code's own `deactivate()` contract takes no arguments, so it has no way to receive
// `activate()`'s session object directly — this is the one module-level reference left, existing
// solely to bridge that gap, not a singleton with a "why module level" justification of its own.
let activeSession: ExtensionSession | undefined;

// Async so VS Code awaits confirmed-dead-child teardown (BackendManager.dispose() → stop())
// before the extension host finishes tearing down — otherwise a reload's replacement
// BackendManager instance is structurally unable to ever clean up this instance's spawned child.
export async function deactivate(): Promise<void> {
  await activeSession?.backendManager?.dispose();
}


function promptPluginName(): Thenable<string | undefined> {
  return vscode.window.showInputBox({
    prompt: 'Enter new plugin name (e.g. MyPatch.esp)',
    validateInput: v => {
      if (!v) return 'Name is required';
      if (!/\.(esp|esm|esl)$/i.test(v)) return 'Extension must be .esp, .esm, or .esl';
      return undefined;
    },
  });
}



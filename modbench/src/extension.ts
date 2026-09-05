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
import { reconcilePluginsWithDisk } from './modmanager/pluginsReconcile';
import { say, exitToLoadout, clearTreeWhenBackendDies, refreshMatchingPlugins } from './loadoutTeardown';
import { publishLoadDiagnoses, groupDiagnosesByPlugin } from './medit/loadDiagnostics';
import { registerModInstallCommands, registerModContextCommands, registerSeparatorCommands, registerOverwriteView, registerModsAutoRegisterWatcher, registerPluginsReconcileWatchers, registerNotMo2InstanceWelcome, createModListView, registerDownloadsView, isStandaloneDeployment, registerDeploymentModeContext, registerDeployCommands, registerLaunchCommand, registerModListCoreCommands } from './modmanager/modManagementCommands';
import { onModCheckboxChanged } from './modmanager/modCheckboxHandler';
import { meditConfig, makeDetectPaths, setMo2InstanceContext } from './workspaceConfig';


// Everything `activate()` constructs that a choke point registered elsewhere must also reach —
// one object rather than nine module-level singletons. `undefined` until the wiring reaches the
// field; every reader treats "not yet built" and "no live workspace" alike.
interface ExtensionSession {
  backendManager?: BackendManager;
  loadoutHeaderProvider?: LoadoutHeaderProvider;
  pluginsTree?: PluginsTreeComposite<PluginListNode, PluginTreeNode>;
  /** ADR-0044: the one path by which the Plugin load order reaches Editing. */
  loadOrderSync?: LoadOrderSync;
  /** The same view, as a `TreeView` — carries the load's own progress and incompleteness
   *  statement (`TreeView.message`, via `say` below). */
  pluginsTreeView?: vscode.TreeView<PluginListNode | PluginTreeNode>;
  /** The same view's name filter — a second, independent narrowing axis from the record filter,
   *  which has to be able to add itself to this view's readout (`say` below). */
  pluginsNameFilter?: NameFilter;
  /** Plugin filename → the `vscode.git` `Repository` for that plugin's mod folder. Kept so a
   *  successful field edit can prompt that repository's `status()` and make the Source Control
   *  panel pick up the working-tree change without a manual Refresh. */
  pluginRepositories?: Map<string, MinimalRepository>;
  /** The record browser behind the merged tree's children — mEdit starting/stopping is what
   *  tells its record rows which plugins are immutable (Remove hidden via `contextValue`). */
  recordBrowserProvider?: PluginTreeProvider;
  /** The record filter's single writer: the context key its Clear action is gated on, the code
   *  lens's active SQL, and the readout. */
  setFilterActive?: ReturnType<typeof makeSetFilterActive>;
  /** Fetch the session-load malformed-plugin scan and publish it — Problems panel and tree
   *  decoration. */
  refreshDiagnoses?: () => void;
  /** Held on the session so the teardown writers can clear it alongside the tree badge. */
  loadDiagnostics?: vscode.DiagnosticCollection;
}


// ADR-0035: one progress indicator, in the view whose contents are loading — not a per-command
// `ProgressLocation.Notification`. The message clears on every exit path, so no failure leaves
// the view claiming a load that is not running.
function withPluginsViewProgress(session: ExtensionSession, work: () => Promise<void>): Promise<void> {
  return Promise.resolve(vscode.window.withProgress(
    { location: { viewId: 'modbench.pluginListTree' } },
    async () => { try { await work(); } finally { say(session, undefined); } },
  ));
}

// Which plugin files Editing's load order names — the backend's own list, not the snapshot we
// sent, because the backend prepends implicit masters. Keyed by filename, reading the
// `inLoadOrder` copy: two held copies can share one (ADR-0044).
interface HeldPluginFiles {
  files: Set<string>;
  readOnly: Set<string>;
  masterIssues: Map<string, MasterIssue[]>;
  /** Lowercased filename → does this plugin own a record the *current* record filter matches.
   *  Carried in this hand-off because every reconcile reaches it downstream of `syncFilterState()`,
   *  so the map never outlives the filter state it describes. */
  matches: Map<string, boolean>;
  /** Which of those plugins are tracked — their mod folder holds a `.git` (ADR-0041). A `.git`
   *  appearing or vanishing is itself a `mods/**` watcher event, which is what makes tracking
   *  reach the rows without a reload. */
  tracked: Set<string>;
}

function heldPluginFilesFrom(repository: ApiPluginRepository): () => Promise<HeldPluginFiles> {
  return async () => {
    const plugins = (await repository.getPlugins()).filter((p) => p.inLoadOrder);
    return {
      files: new Set(plugins.map((p) => p.name)),
      readOnly: new Set(plugins.filter((p) => p.isImmutable).map((p) => p.name)),
      // ADR-0037: `masterIssues` is a required, non-nullable array on the wire, so it is read
      // straight through — a `??` default here would compensate for nothing the backend can do.
      masterIssues: new Map(plugins.map((p) => [p.name, p.masterIssues] as const)),
      matches: new Map(plugins.map((p) => [p.name.toLowerCase(), p.hasMatchingRecords] as const)),
      tracked: new Set(plugins.filter((p) => p.isTracked).map((p) => p.name)),
    };
  };
}


// The single writer for all three surfaces the record filter drives, so `modbench.filterActive`
// is written from exactly one place. The filter is named by its *source*, never by its SQL,
// because a `WHERE` clause is not a readout.
function makeSetFilterActive(session: ExtensionSession, filterProvider: FilterCodeLensProvider) {
  return (active: boolean, sql?: string, label?: string) => {
    void vscode.commands.executeCommand('setContext', 'modbench.filterActive', active);
    filterProvider.setActiveSql(active ? (sql ?? null) : null);
    session.pluginsNameFilter?.setBaseDescription(active ? `records: ${label ?? 'SQL'}` : undefined);
  };
}


// The backend launches with the extension: the DB-file-backed session made startup cheap enough
// that lifecycle stopped being a user decision (ADR-0022). A config change is the only gesture
// that can mean "try again".
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
  const session: ExtensionSession = {};
  activeSession = session; // deactivate()'s only way to reach it
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
  // The session-load scan's own collection — a sibling of the compile one, targeting plugin
  // binaries, replaced wholesale per scan.
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
  // Retargets on `activeRecordTracker`'s active-record changes rather than an explicit command.
  // The onCountChanged callback closes over `referencedByTreeView` before its `const` line runs —
  // safe because VS Code never calls getChildren until createTreeView returns.
  const referencedByTreeProvider = new ReferencedByTreeProvider(client, log, (count) => {
    // The runtime count badge keeps the declared "Plugins - Referenced By" prefix (ADR-0035).
    referencedByTreeView.title = count === undefined ? 'Plugins - Referenced By' : `Plugins - Referenced By (${count})`;
  });
  const referencedByTreeView = vscode.window.createTreeView('modbench.referencedByTree', {
    treeDataProvider: referencedByTreeProvider,
    canSelectMany: true,
  });
  const activeRecordSubscription = activeRecordTracker.onDidChangeActiveRecord(
    (formKey) => referencedByTreeProvider.showFor(formKey));
  // Primes the view with whatever activeRecordTracker already knows — a no-op today, but it makes
  // ActiveRecordTracker.current()'s "initial state" contract true rather than aspirational.
  referencedByTreeProvider.showFor(activeRecordTracker.current());
  // Run once per completed reconcile, never a poller: a reconcile is the only moment either offer
  // reason can newly arise.
  const showCrashRepairOffers = (offers: CrashRepairOffer[]) => presentCrashRepairOffers(
    offers,
    (message, options, ...buttons) => Promise.resolve(vscode.window.showWarningMessage(message, options, ...buttons)),
    (offer, atRef) => compileAndReport(
      controller, compileDiagnostics, { name: offer.plugin, origin: offer.origin }, atRef, repository,
    ),
  );
  const { modListProvider, downloadsProvider, pluginListProvider, modlistSource, instanceRoot, enterEditing } = registerLoadoutSurfaces(session, { context, outputChannel, controller, recordBrowser: treeProvider, heldPluginFiles: heldPluginFilesFrom(repository), showCrashRepairOffers });
  // ADR-0026 background tier — the scan is advisory, so a blip logs and retries next reconcile,
  // never toasts. Fire-and-forget: the tree hand-off must not wait on a whole-load-order scan.
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

  // Exposed for integration tests — unused in production. The match map has no other externally
  // observable surface, and a backend going unhealthy needs the real BackendManager.stop().
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
  // A getter through the single game-directory resolver, not a Promise settled once. Folds a
  // resolution failure to undefined, degrading vanilla-master lookups and badges.
  dataFolder: () => Promise<string | undefined>;
  /** The record browser that supplies a plugin row's children. Passed as the composite's
   *  child source and never touched directly here. */
  recordBrowser: PluginTreeProvider;
}
// ADR-0035: the view is a `PluginsTreeComposite` over two providers — these rows and the record
// browser's children — so each row expands into its records. The composition root is the only
// place that may know both.
function registerPluginListView(deps: PluginListDeps): { pluginListProvider: PluginListProvider; disposables: vscode.Disposable[] } {
  const { session, modlistSource, outputChannel, reporter, instanceRoot, dataFolder, recordBrowser } = deps;
  // `log` is a compat shim (defaults to .info) for modules taking a flat `(msg) => void`.
  const log = (msg: string) => outputChannel.info(msg);
  const pluginListProvider = new PluginListProvider({ source: modlistSource, log, reporter, instanceRoot, dataFolder });
  const composite = new PluginsTreeComposite<PluginListNode, PluginTreeNode>({
    rows: pluginListProvider,
    // A thin positional adapter, not `recordBrowser` directly: the composite's
    // `getPluginChildren(pluginFile)` has no `origin` slot (a root row never has one to give),
    // while `PluginTreeProvider` keeps its `(name, origin?)` shape for browsing a losing copy.
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
    // Undefined — never fetched, or nothing found for this file — reads as "matches", the
    // composite's own fallback for an accessor that has nothing to say.
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
    // Title-bar rule 7 (docs/specs/containers.md): hierarchical trees get Collapse All, and this
    // one is hierarchical — plugin → record type → record.
    showCollapseAll: true,
  });
  session.pluginsTreeView = pluginListView; // progress and message live here
  session.pluginsNameFilter = registerPluginsNameFilter(pluginListView, pluginListProvider);
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
    // Grays an implicit master's row the way MO2 grays COL_NAME for a forceLoaded plugin — live
    // against PluginListProvider's own implicitMasterNames() so it never drifts from the tree.
    vscode.window.registerFileDecorationProvider(
      new ImplicitMasterDecorationProvider(dataFolder, () => pluginListProvider.implicitMasterNames()),
    ),
    ...wireLoadOrderWatchers(session.loadOrderSync!, instanceRoot, pluginListProvider),
    pluginListView.onDidChangeCheckboxState((e) => onPluginCheckboxChanged(e, pluginListProvider, outputChannel)),
    revealInExplorerCommand,
    // ADR-0044: the checkbox gesture's other half. The plugins.txt watcher would fire for the same
    // write; asking explicitly keeps the gesture's path off a watcher event, and the sync folds
    // the two into one PUT.
    pluginListProvider.onDidChangeParticipation(() => session.loadOrderSync?.request()),
    session.pluginsNameFilter,
  ] };
}

// One shared concern, the Plugins-tree row's own context menu, as distinct from the record
// editor's own commands.
function registerPluginRowCommands(
  session: ExtensionSession,
  controller: EditingController,
  repository: ApiPluginRepository,
  activeRecordTracker: ActiveRecordTracker<vscode.WebviewPanel>,
  outputChannel: vscode.LogOutputChannel,
  compileDiagnostics: vscode.DiagnosticCollection,
): vscode.Disposable[] {
  // A node's own `origin` when the row carries it (ADR-0036), else `controller.resolveOrigin`;
  // there is no ambient fallback worth a QuickPick, which is why these commands are palette-gated.
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
    // xEdit parity (xeMainForm.pas's CopyInto, reached from both the tree row and the column
    // header): one command per gesture, reached from either entry point. `arg` resolves to the
    // same {formKey, plugin, origin} identity either way.
    vscode.commands.registerCommand('modbench.record.copyAsOverride', async (arg?: RecordNode | ColumnHeaderContext) => {
      await runCopyRecordCommand('copy-as-override', arg, controller, repository, resolveOriginOrReport, outputChannel);
    }),
    vscode.commands.registerCommand('modbench.record.copyAsNewRecord', async (arg?: RecordNode | ColumnHeaderContext) => {
      await runCopyRecordCommand('copy-as-new', arg, controller, repository, resolveOriginOrReport, outputChannel);
    }),
    registerOpenHeaderCommand(),
  ];
}

// A join, not an Editing-only gesture (its argument is Mod Management's own row type), so it
// lives alongside the other plugin-row commands rather than with the record panel's own.
function registerOpenHeaderCommand(): vscode.Disposable {
  return vscode.commands.registerCommand('modbench.openHeader', (node?: PluginListNode) => {
    const pluginName = node && pluginFileOf(node);
    if (!pluginName) return;
    void vscode.commands.executeCommand('modbench.openEditor', {
      formKey: headerFormKeyFor(pluginName), label: pluginName,
    });
  });
}

// Edits is the default `.gitignore` preset — Everything is the opt-in authoring choice. A
// mega-plugin's serialization is a one-time, worst-case tens-of-seconds cost (ADR-0041), so this
// runs under the Plugins-view progress indicator.
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
        onProgress: (status) => say(session, trackProgressMessage(origin, status)),
      });
      if (!ok) return;
      void vscode.window.showInformationMessage(`Modbench: Tracked "${origin}".`);
      await onTracked();
    });
  });
}

// `overwrite/` is listed first so it is the QuickPick's pre-highlighted default — `showQuickPick`
// has no `activeItem` option, and array order is the only way to pre-highlight — preserving the
// xEdit-under-MO2 reflex.
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
    // Accepted residue: the mod folder is registered before the create POST runs. If that POST
    // fails, the mod stays registered — empty and disabled, same as any fresh install — rather
    // than being rolled back.
    await modlistSource.installMod(modName, staging, {});
  } finally {
    await fs.promises.rm(staging, { recursive: true, force: true });
  }
  return resolvePluginDestination(instanceRoot, { kind: 'newMod', modName });
}

// ADR-0041: only once Editing's create endpoint has actually succeeded does Mod Management's
// `appendPlugin` add the load-order line — never the other way around, so the load order can
// never name a file that does not exist.
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


// Origin-scoped: the repo, not any one plugin, is the unit of baselines and rebase. Also the
// *re-runnable* form — {@link SourceRepository.RebaseEditBranch}'s resumption-aware design means
// this same command both starts a rebase and resumes one left conflicted.
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

// Reachable from a plugin row, from the record editor's title bar (the *active* record's owning
// plugin — never a QuickPick, which risks compiling the wrong plugin), and from the palette
// (QuickPick fallback only when neither is in hand).
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

// One confirmation names the ref literally, never "pristine" — there is no stored mode
// (ADR-0041). Tree-row only: naming a ref with no plugin in hand isn't worth a QuickPick.
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

// ADR-0044: the sync every loadout gesture feeds. 250 ms covers the bursts — both watchers
// firing for one install, a drag reorder's write plus its watcher event, a checkbox toggle's
// request plus the event it causes.
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
    // gameDirResolver's `null` and the sequencer's `undefined` are the same fact, normalized at
    // the one seam between them rather than teaching the sequencer a second falsy spelling.
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


// ADR-0044: reactive watchers, never a timer. Three because one misses gestures: `modlist.txt`
// catches install, uninstall and reprioritise; `mods/**` a folder appearing without one;
// `plugins.txt` the Plugin axis, whoever wrote it. `debounceMs: 0` — the sync already debounces.
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

// The axis that narrows *which plugin rows* appear, composing with (never replacing) the record
// filter's axis over which records appear under an expanded row.
function registerPluginsNameFilter(
  view: vscode.TreeView<PluginListNode | PluginTreeNode>, provider: PluginListProvider,
): NameFilter {
  return registerNameFilter({
    view, viewId: 'modbench.pluginListTree', placeholder: 'Filter plugins…',
    setFilter: (text) => provider.setFilter(text),
    hasRows: async () => (await provider.getChildren()).length > 0,
  });
}


// The Loadout half of activation as one step. The header must register even on the paths where
// `registerLoadoutView` bails (no workspace, or not an MO2 instance): it is the container's first
// view and must never be a hole.
function registerLoadoutSurfaces(session: ExtensionSession, deps: Omit<LoadoutViewDeps, 'revealLog'>): {
  modListProvider?: ModListProvider; downloadsProvider?: DownloadsProvider; pluginListProvider?: PluginListProvider;
  // Forwarded so the composition root can wire modbench.newPlugin's destination QuickPick — both
  // are undefined together with the providers above.
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
  /** Run the loud crash-repair offer sequence for whatever a completed reconcile found. Composed
   *  at the composition root, where the diagnostics collection and compile door already live. */
  showCrashRepairOffers: (offers: CrashRepairOffer[]) => Promise<void>;
}
// A crash-restart is a fresh backend, so the reconcile runs again from scratch — the same re-entry
// path a fresh launch takes, not a bespoke recovery.
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
  // The flat log shim, built locally rather than threaded in as its own Deps field.
  const log = (msg: string) => outputChannel.info(msg);
  const instanceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!instanceRoot) {
    outputChannel.info('[extension] No workspace folder open — Mod List view not registered.');
    // Explicit, not left implicitly falsy: the viewsWelcome `when` clause also guards on VS Code's
    // own `workspaceFolderCount != 0`, but every exit path sets both keys rather than leaving one.
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
    // Memoised, and invalidated only when modbench.mods.gameDirectory changes, so no consumer can
    // disagree about which folder is current. Deliberately not an activation-scoped Promise
    // resolved once.
    const gameDirResolver = createGameDirectoryResolver(instanceRoot, meditConfig, makeDetectPaths(), detectWinePrefix, vscode.workspace.onDidChangeConfiguration);
    // Never rejects: a null resolution and a misconfigured setting both fold to undefined, so the
    // views degrade rather than throw. Memoised by the resolver's cache generation, so a
    // stuck-broken setting logs once instead of once per visible file.
    const dataFolder = dataFolderFrom(gameDirResolver, (e) =>
      outputChannel.error(`[extension] resolving the game directory failed: ${e instanceof Error ? e.message : String(e)}`));
    const modListProvider = new ModListProvider({ source: modlistSource, log, instanceRoot, reporter: modListReporter, dataFolder });
    // ADR-0044: built before the Plugins tree, because both the tree's hasMatchingRecords accessor
    // and enterEditing below need the session slot filled first.
    session.loadOrderSync = makeLoadOrderSync({
      session, instanceRoot, modlistSource, controller, outputChannel, heldPluginFiles, showCrashRepairOffers, gameDirResolver,
    });
    // plugins.txt converges on what disk provides; the write reaches the Plugins tree and Editing's
    // Plugin load order sync through the plugins.txt watcher.
    const reconcilePlugins = () => reconcilePluginsWithDisk({
      source: modlistSource, instanceRoot, dataFolder, channel: outputChannel,
      buildIndex: (entries) => buildFileConflictIndex(entries, instanceRoot, (msg) => outputChannel.debug(msg)),
    });
    const { pluginListProvider, disposables: pluginListDisposables } =
      registerPluginListView({ session, modlistSource, outputChannel, reporter: makeReporter(outputChannel, 'pluginList'), instanceRoot, dataFolder, recordBrowser });
    const { modListView, modListFilter, updateProfileDescription } =
      createModListView(modListProvider, modlistSource, outputChannel);
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
      ...registerPluginsReconcileWatchers(instanceRoot, () => void reconcilePlugins()),
      ...pluginListDisposables,
    );
    // The watchers above cover changes made while Modbench runs; these one-time passes reconcile
    // what happened while it wasn't. Plugins follow mods, so the first pass feeds the second.
    void reconcileModlistWithModsDir(modlistSource, () => modListProvider.invalidate(), outputChannel)
      .then(reconcilePlugins);
    const { downloadsProvider, disposables: downloadsDisposables } = registerDownloadsView(instanceRoot, outputChannel);
    context.subscriptions.push(...downloadsDisposables);
    const refreshAll = makeRefreshAll(modListProvider, pluginListProvider, downloadsProvider, updateProfileDescription);
    return { modListProvider, downloadsProvider, pluginListProvider, modlistSource, instanceRoot, refreshAll, enterEditing };
}

// Refresh is one need, not three: a partial refresh is the state where the user believes they
// have resynced and one tree still quietly disagrees.
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
  /** Absent when no workspace is open or it isn't an MO2 instance — the header still registers
   *  (it is the container's first view and must never be a hole), it just has no profile. */
  modlistSource?: Mo2ModlistSource;
  /** Absent for the same reason as `modlistSource`; without it there is nothing to be
   *  deployed, so the deployment row stays absent regardless of the configured mode. */
  instanceRoot?: string;
  refreshAll?: () => void;
}
// Wired here, at the composition root, because it spans both bounded contexts; the provider
// itself takes only getters and knows about neither.
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
    // Its scope is the workspace, so it lives here rather than on any single tree — and it is only
    // the safety net for a flaky watcher, never the primary path.
    vscode.commands.registerCommand('modbench.refresh', () => {
      refreshAll?.();
      provider.refresh();
    }),
  );
  // The header's rows read no backend or load order state, so there is nothing here for a backend
  // status transition to invalidate.
}


// ADR-0035: rows gain chevrons here — and *finish* gaining them here. A progressive reconcile's
// ticks carry only the indexed set, because read-only state and master issues are
// whole-load-order derivations a partial tick cannot answer.
async function applyLoadOrderToTree(
  session: ExtensionSession,
  heldPluginFiles: () => Promise<HeldPluginFiles>,
  failures: { name?: string | null; reason?: string | null }[],
  outputChannel: vscode.LogOutputChannel,
  // Carried in only to be logged next to what reached the tree. Deliberately not `plugins.length`
  // from the caller's snapshot: that omits the implicit masters the backend prepends, so every
  // healthy reconcile would read as short.
  totalPlugins: number,
): Promise<void> {
  try {
    const held = await heldPluginFiles();
    // Do not remove as logging noise: `held.files.size + failures.length` landing close to
    // `totalPlugins` is what tells a stuck-tail reconcile here from one broken upstream.
    outputChannel.info(
      `[extension] applying reconciled load order to tree: ${held.files.size} in the load order, ${failures.length} failed, of ${totalPlugins} copies`,
    );
    // ADR-0037: the same failures the toast inside putLoadOrder already consumed — held here, not
    // re-derived, and handed to the tree through the same setLoadOrder bundle.
    const loadFailures = new Map(failures.map((f) => [f.name ?? '?', f.reason ?? 'Unknown error'] as const));
    // Set before setLoadOrder fires its re-render, so no row renders off a match set stale from
    // whatever reconcile preceded this one.
    session.loadOrderSync?.setMatches(held.matches);
    session.pluginsTree?.setLoadOrder(held.files, held.readOnly, held.masterIssues, loadFailures);
    // The same read-only set, to the record rows — theirs is contextValue (Remove hidden), the
    // plugin rows' is the tooltip note.
    session.recordBrowserProvider?.setImmutablePlugins(held.readOnly);
    // And tracked-ness, the record rows' other contextValue axis. Every reconcile re-pushes it: a
    // `.git` appearing or vanishing under `mods/` is a watcher event, and that is a reconcile.
    session.recordBrowserProvider?.setTrackedPlugins(held.tracked);
    // Every reconcile re-runs the malformed-plugin scan — setLoadOrder above just cleared the last
    // scan's decorations, and this brings the new answer when it lands.
    session.refreshDiagnoses?.();
  } catch (err) {
    // Leaving every row a leaf is a safe *render* but not an honest one: the reconcile did land,
    // so the tree would claim editing is unavailable with nothing on screen to say why (ADR-0026).
    const message = err instanceof Error ? err.message : String(err);
    outputChannel.error(`[extension] reading the backend's plugin list failed; plugin rows will not expand: ${message}`);
    void vscode.window.showWarningMessage(
      'Modbench: The load order was reconciled, but the plugin list could not be read — plugin rows will not expand into records. Close and relaunch mEdit to retry.',
    );
  }
}

// `loadOrderSync.arm()` returns a pure check — it cannot hold an `outputChannel` (ADR-0044) — so
// each call site logs explicitly instead.
function reportAbandoned(outputChannel: vscode.LogOutputChannel): void {
  outputChannel.info('[extension] the reconcile was abandoned before it landed; leaving the closed view alone');
}

// Each tick's `totalPlugins` is the backend's count, implicit masters included — a larger number
// than the frontend's own snapshot, and the one `applyLoadOrderToTree`'s completion log compares
// against.
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
  /** Shared with the views — memoised and invalidated only when modbench.mods.gameDirectory
   *  changes, so a snapshot always agrees with what they show. */
  gameDirResolver: GameDirectoryResolver;
}

// ADR-0035: owns its own progress indicator rather than leaving each caller to wrap it, and
// reports its steps through `say`.
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
    // No game directory means nothing to build a snapshot from — don't strand the UI in an empty
    // editing view. `flush()` is used because this path wants the outcome, not just a promise.
    if ((await session.loadOrderSync!.flush()) === 'no-game-directory') exitToLoadout(session);
  };
  return () => withPluginsViewProgress(session, enter);
}


// Undici's default Agent times out a fetch with no response bytes after ~300s; the backend's
// blocking endpoints legitimately run for minutes, so 0 disables both. Bound per-request:
// `setGlobalDispatcher` never reaches the extension host's outgoing requests.
function createUnlimitedFetch(): (input: Request) => Promise<Response> {
  const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
  // Handed a global `Request`, undici's own `fetch` coerces it to a URL string and fails, so it is
  // unpacked — `signal` included, or an abandoned reconcile's abort never reaches the network.
  return async (input) => {
    const hasBody = input.method !== 'GET' && input.method !== 'HEAD';
    const body = hasBody ? await input.clone().arrayBuffer() : undefined;
    return undiciFetch(input.url, { method: input.method, headers: [...input.headers], body, dispatcher, signal: input.signal });
  };
}

function createBackendManager(port: number, channel: vscode.LogOutputChannel, statusBarItem: vscode.StatusBarItem): BackendManager {
  // Bundled backend binary (see build:backend / .vscodeignore). __dirname is
  // out/ at runtime; the published self-contained executable lives in backend/.
  const backendExe = process.platform === 'win32' ? 'MEditService.Api.exe' : 'MEditService.Api';
  return new BackendManager({
    port,
    log: (msg) => channel.info(msg),
    // Pipe the backend's Serilog console output into the same channel, at its own level. Only
    // applies to a backend we spawn — an attached dev-launched one logs to its own terminal.
    onOutput: makeBackendLogForwarder(channel),
    // The backend's Serilog minimum level follows the channel's at spawn time, so raising the
    // channel to Debug actually surfaces backend lines. Read fresh per spawn; never applied when
    // attaching to an already-running backend.
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

function setupScripts(cfg: vscode.WorkspaceConfiguration): { scriptsPath: string; filterProvider: FilterCodeLensProvider } {
  const scriptsPathCfg: string = cfg.get('scriptsPath') ?? '';
  const scriptsPath = scriptsPathCfg || path.join(os.homedir(), '.medit', 'scripts');
  fs.mkdirSync(scriptsPath, { recursive: true });

  const filterProvider = new FilterCodeLensProvider(scriptsPath);
  return { scriptsPath, filterProvider };
}


// VS Code's own `deactivate()` takes no arguments, so it has no way to receive `activate()`'s
// session object directly — this module-level reference exists solely to bridge that gap.
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



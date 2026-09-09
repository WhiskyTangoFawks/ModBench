import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as cp from 'child_process';
import { Agent, fetch as undiciFetch } from 'undici';
import { BackendManager } from './medit/BackendManager';
import { backendLogLevelArgs, makeBackendLogForwarder } from './medit/backendLog';
import { createApiClient, openNotificationStream, type CrashRepairOffer } from './medit/ApiClient';
import {
  SseNotificationSubscriber, subscribeTreeToNotifications, subscribeRecordPanelsToNotifications,
} from './medit/NotificationSubscriber';
import { EditingController } from './medit/EditingController';
import { PluginTreeProvider, type RecordNode } from './plugins/PluginTreeProvider';
import { ActiveRecordTracker } from './medit/ActiveRecordTracker';
import { ApiPluginRepository } from './medit/PluginRepository';
import { FilterCodeLensProvider } from './medit/FilterCodeLensProvider';
import { ReferencedByTreeProvider } from './medit/ReferencedByTreeProvider';
import { broadcastToRecordPanels } from './medit/onRecordEdited';
import { EXTENSION_TO_WEBVIEW, type ColumnHeaderContext } from './medit/messages';
import { presentCrashRepairOffers } from './medit/crashRepairOffer';
import { makeReporter } from './reporter';
import { registerEditorCommands, registerRecordLifecycleCommands, makeResolveOriginOrReport, runCopyRecordCommand, compileAndReport, registerHeldTrackedRepositories, refreshSourceControlFor, wireExternalChangePending } from './medit/editorCommands';
import { exitEditing, refreshMatchingPlugins } from './editingTeardown';
import { createToolbox } from './toolbox';
import type { ExtensionSession } from './session';
import { meditConfig } from './workspaceConfig';
import {
  registerTrackCommand, registerRebaseCommand, registerSaveAndCompileCommand, registerCompileAtRefCommand,
  registerOpenHeaderCommand,
} from './plugins/pluginRowCommands';



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
      exitEditing(session); // reset the view and tear down any half-started backend
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
  const openPanels = new Map<string, vscode.WebviewPanel>();
  const recordPanels = new Set<vscode.WebviewPanel>();
  // The Referenced By view's input — which record panel is active and what FormKey it shows.
  const activeRecordTracker = new ActiveRecordTracker<vscode.WebviewPanel>();
  const { scriptsPath, filterProvider } = setupScripts(meditConfig());

  // ADR-0046 invariant 12: one subscription for the whole session, `stop()`ped by
  // editingTeardown wherever the backend goes unhealthy.
  session.notificationSubscriber = new SseNotificationSubscriber({
    openStream: (signal) => openNotificationStream(client, signal),
    log: (msg) => outputChannel.debug(msg),
  });
  // `start()`ed as soon as the backend is healthy — before the first PUT, so its own progress
  // rides the stream too — not on the first successful reconcile.
  session.backendManager.on('status', () => {
    if (session.backendManager?.isHealthy) session.notificationSubscriber?.start();
  });
  context.subscriptions.push(
    { dispose: subscribeTreeToNotifications(session.notificationSubscriber, treeProvider) },
    { dispose: subscribeRecordPanelsToNotifications(session.notificationSubscriber, recordPanels, activeRecordTracker) },
  );

  session.setFilterActive = makeSetFilterActive(session, filterProvider);

  const controller = new EditingController({
    client,
    repository,
    notificationSubscriber: session.notificationSubscriber,
    log,
    refreshTree: () => treeProvider.refresh(),
    setStatusText: (t) => { statusBarItem.text = t; },
    showWarning: (msg) => { void vscode.window.showWarningMessage(msg); },
    showError: (msg) => { void vscode.window.showErrorMessage(msg); },
    setFilterActive: session.setFilterActive,
    refreshMatchingPlugins: () => { void refreshMatchingPlugins(session); },
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
  // The MO2 side, whole: the Instance, the four views, their gestures and the backend sync.
  const toolbox = createToolbox({
    outputChannel, session, controller,
    recordBrowser: treeProvider,
    pluginFacts: repository,
    showCrashRepairOffers,
    loadDiagnostics,
  });
  context.subscriptions.push(
    toolbox,
    { dispose: wireExternalChangePending(repository, controller, outputChannel, session.notificationSubscriber) },
    referencedByTreeView,
    activeRecordSubscription,
    vscode.languages.registerCodeLensProvider({ language: 'sql' }, filterProvider),
    ...registerPluginRowCommands(session, controller, repository, activeRecordTracker, outputChannel, compileDiagnostics),
    ...registerEditorCommands({
      context, openPanels, recordPanels, activeRecordTracker, port, treeProvider, controller, repository, scriptsPath, referencedByTreeView, outputChannel,
      mergedTreeSelection: () => session.pluginsTreeView?.selection ?? [],
      refreshMatchingPlugins: () => { void refreshMatchingPlugins(session); },
      refreshSourceControlFor: (plugin) => refreshSourceControlFor(session.pluginRepositories, plugin, outputChannel),
    }),
  );

  statusBarItem.text = '$(plug) mEdit';

  wireAutoLaunch(session, context, outputChannel, toolbox.enterEditing);

  // Exposed for integration tests — unused in production. `instance`: lets a test await past a
  // sequence instead of sleeping.
  return {
    modListProvider: toolbox.modListProvider, downloadsProvider: toolbox.downloadsProvider,
    pluginsTree: toolbox.pluginsTree,
    pluginListView: session.pluginsTreeView, treeProvider,
    outputChannel, enterEditing: toolbox.enterEditing, exitEditing: () => exitEditing(session),
    instance: toolbox.instance,
  };
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

import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as cp from 'child_process';
import { backendLogLevelArgs, makeBackendLogForwarder } from './medit/backendLog';
import { backendStatusText, wireBackendStatus } from './medit/backendStatus';
import { HttpMEditClient, type BackendLifecycleOptions, type CrashRepairOffer } from './client';
import { announceConflictsComputed, subscribeTreeToNotifications, subscribeRecordPanelsToNotifications } from './medit/notificationWiring';
import { PluginTreeProvider } from './plugins/PluginTreeProvider';
import { FilterCodeLensProvider } from './medit/FilterCodeLensProvider';
import { ReferencedByTreeProvider, referencedByCopyValueText } from './editor/ReferencedByTreeProvider';
import { presentCrashRepairOffers } from './plugins/crashRepairOffer';
import { makeReporter } from './reporter';
import { askQuestion } from './dialog';
import { moveToTrash } from './trash';
import { EXTENDED_FIELD_TEMP_ROOT, extendedFieldFile } from './medit/extendedFieldFiles';
import { registerEditorCommands, ActiveRecordTracker, EditsInFlight } from './editor';
import { exitEditing, refreshMatchingPlugins, say } from './editingTeardown';
import { createToolbox } from './toolbox';
import { withPluginsViewProgress, type ExtensionSession } from './session';
import { meditConfig } from './workspaceConfig';
import { GAME_FOLDER_SETTING } from './instanceAdapter/gameDirectory';
import { isTracked } from './instanceAdapter/files';
import { pluginFolder } from './instanceAdapter/layout';
import {
  registerTrackCommand, registerRebaseCommand, registerSaveAndCompileCommand, registerCompileAtRefCommand,
  registerOpenHeaderCommand, compileAndReport, registerHeldTrackedRepositories, refreshSourceControlFor,
  watchRepositoryStates, type MinimalRepository,
} from './plugins/pluginRowCommands';
import { originFiles, type OriginFilesOf } from './instanceLoader/loadOrderSnapshot';
import {
  registerLoadMoreCommand, registerFilterCommands, makeShowRecordFilter, type FilterScripts,
} from './plugins/recordFilterCommands';
import { wireQuestionOpen } from './plugins/externalChangeWiring';
import { errorMessage } from './ports/errorMessage';

// The backend launches with the extension: the DB-file-backed session made startup cheap enough
// that lifecycle stopped being a user decision (ADR-0002). A config change is the only gesture
// that can mean "try again".
function wireAutoLaunch(
  session: ExtensionSession, client: HttpMEditClient, context: vscode.ExtensionContext,
  outputChannel: vscode.LogOutputChannel, enterEditing: (() => Promise<void>) | undefined,
): void {
  const reporter = makeReporter(outputChannel, 'launch');
  const launch = async () => {
    try {
      await enterEditing?.();
    } catch (err) {
      exitEditing(session, client); // tear down any half-started backend
      reporter.report('error', 'Failed to launch mEdit.', errorMessage(err));
    }
  };
  void launch();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(GAME_FOLDER_SETTING) && client.status !== 'attached') void launch();
    }),
  );
}

export type ActivateExports = ReturnType<typeof activate>;

export function activate(context: vscode.ExtensionContext) {
  const session: ExtensionSession = {};
  const port: number = meditConfig().get('backendPort') ?? 5172;

  const outputChannel = vscode.window.createOutputChannel('Modbench', { log: true });
  context.subscriptions.push(outputChannel);
  // `log` is a compat shim (defaults to .info) for modules taking a flat `(msg) => void`.
  const log = (msg: string) => outputChannel.info(msg);

  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  context.subscriptions.push(statusBarItem);
  // Compile's diagnostics — one collection for every tracked mod's source files, kept
  // current per compile (publishCompileDiagnostics replaces a mod's own entries wholesale each run).
  const compileDiagnostics = vscode.languages.createDiagnosticCollection('modbench-compile');
  context.subscriptions.push(compileDiagnostics);
  // The session-load scan's own collection — a sibling of the compile one, targeting plugin
  // binaries, replaced wholesale per scan.
  const loadDiagnostics = vscode.languages.createDiagnosticCollection('modbench-diagnosis');
  context.subscriptions.push(loadDiagnostics);
  session.loadDiagnostics = loadDiagnostics;

  // The mEdit client (ADR-0002): built once here, owning the backend process and every call
  // across the seam; nothing outside this module constructs the generated client, `openapi-fetch`
  // or the notification stream.
  const meditClient = new HttpMEditClient({ backend: backendOptions(port, outputChannel), log });
  activeClient = meditClient; // deactivate()'s only way to reach it
  const treeProvider = new PluginTreeProvider(meditClient, log);
  const openPanels = new Map<string, vscode.WebviewPanel>();
  const recordPanels = new Set<vscode.WebviewPanel>();
  // The Referenced By view's input — which record panel is active and what FormKey it shows.
  const activeRecordTracker = new ActiveRecordTracker<vscode.WebviewPanel>();
  const editsInFlight = new EditsInFlight(activeRecordTracker);
  const filterScripts = setupScriptsFolder(meditConfig());
  const filterProvider = new FilterCodeLensProvider();

  // ADR-0014 invariant 2: one subscription for the whole session, opened and closed with the
  // backend by the mEdit client itself.
  context.subscriptions.push(
    { dispose: subscribeTreeToNotifications(meditClient, treeProvider) },
    { dispose: subscribeRecordPanelsToNotifications(meditClient, recordPanels, activeRecordTracker, editsInFlight) },
  );

  session.showRecordFilter = makeShowRecordFilter(filterProvider, session);
  context.subscriptions.push({ dispose: () => { session.pluginRepositoryStates?.dispose(); } });

  // Fires on every completed reconcile and on a landed Track: tells every open record panel to
  // refetch its comparison, and (re-)registers every tracked mod's repo with `vscode.git`
  // (ADR-0007 — the one reliable point to do so).
  const notifyConflictsComputed = () => {
    announceConflictsComputed(recordPanels, editsInFlight);
    void registerHeldTrackedRepositories(
      meditClient, outputChannel, (repos) => { holdPluginRepositories(session, repos); }, isTracked, pluginFolder);
  };
  // Retargets on `activeRecordTracker`'s active-record changes rather than an explicit command.
  // The onCountChanged callback closes over `referencedByTreeView` before its `const` line runs —
  // safe because VS Code never calls getChildren until createTreeView returns.
  const referencedByTreeProvider = new ReferencedByTreeProvider(meditClient, log, (count) => {
    // The runtime count badge keeps the declared "Plugins - Referenced By" prefix (ADR-0013).
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
  // Its `originFiles` closes over the Toolbox built below and re-reads the value each call, so a
  // compile always asks the generation on screen.
  const pluginRowDeps: PluginRowCommandDeps = {
    session, client: meditClient, activeRecordTracker, outputChannel, compileDiagnostics, treeProvider,
    notifyConflictsComputed,
    originFiles: (origin) => originFiles(toolbox.instance?.value.plugins ?? [], origin),
  };
  // Run once per completed reconcile, never a poller: a reconcile is the only moment either offer
  // reason can newly arise.
  const showCrashRepairOffers = (offers: CrashRepairOffer[]) => presentCrashRepairOffers(
    offers,
    askQuestion,
    (offer, atRef) => compileAndReport(
      meditClient, compileDiagnostics, pluginRowDeps.originFiles,
      makeReporter(outputChannel, 'crashRepair'), askQuestion,
      { name: offer.plugin, origin: offer.origin }, atRef,
    ),
  );
  // The MO2 side, whole: the Instance, the four views, their gestures and the backend sync.
  const toolbox = createToolbox({
    outputChannel, session, client: meditClient,
    reporterFor: (tag) => makeReporter(outputChannel, tag),
    ask: askQuestion,
    trash: moveToTrash,
    recordBrowser: treeProvider,
    pluginFacts: meditClient,
    loadDiagnostics,
    setStatusText: (t) => { statusBarItem.text = t; },
    notifyConflictsComputed,
    extensionId: context.extension.id,
    // Copy value's Referenced By adapter (commands.md, Record: copy value) — the Toolbox owns
    // the command's one registration, alongside the other Mods gestures.
    referencedByCopyValueText: (clicked, allSelected) => referencedByCopyValueText(referencedByTreeView, clicked, allSelected),
  });
  context.subscriptions.push(
    toolbox,
    {
      dispose: wireQuestionOpen({
        client: meditClient, outputChannel, treeProvider,
        refreshMatchingPlugins: () => { void refreshMatchingPlugins(session); },
        askQuestion,
        presentCrashRepair: showCrashRepairOffers,
        reporter: makeReporter(outputChannel, 'externalChange'),
        originFiles: pluginRowDeps.originFiles,
      }),
    },
    referencedByTreeView,
    activeRecordSubscription,
    vscode.languages.registerCodeLensProvider({ language: 'sql' }, filterProvider),
    ...registerPluginRowCommands(pluginRowDeps),
    // The record filter scopes the Plugins tree's own rows — a Plugins-view concern (its module
    // lives under plugins/), so it is wired here rather than inside Editor's own registration.
    registerLoadMoreCommand(treeProvider),
    ...registerFilterCommands({
      scripts: filterScripts, client: meditClient, treeProvider,
      refreshMatchingPlugins: () => { void refreshMatchingPlugins(session); },
      showRecordFilter: (filter) => session.showRecordFilter?.(filter),
      reporter: makeReporter(outputChannel, 'recordFilter'),
    }),
    ...registerEditorCommands({
      context, openPanels, recordPanels, activeRecordTracker, editsInFlight, port, treeSync: treeProvider, meditClient, outputChannel,
      reporterFor: (tag) => makeReporter(outputChannel, tag),
      ask: askQuestion,
      mergedTreeSelection: () => session.pluginsTreeView?.selection ?? [],
      refreshMatchingPlugins: () => { void refreshMatchingPlugins(session); },
      refreshSourceControlFor: (plugin, origin) => refreshSourceControlFor(session.pluginRepositories, plugin, origin, outputChannel),
      fieldFile: (field) => extendedFieldFile(EXTENDED_FIELD_TEMP_ROOT, field),
    }),
  );

  statusBarItem.text = backendStatusText(meditClient.status);
  statusBarItem.show();
  context.subscriptions.push({
    dispose: wireBackendStatus(meditClient, {
      setStatusText: (t) => { statusBarItem.text = t; },
      abandonReconcile: () => session.loadOrderSender?.abandon(),
      refreshTree: () => { void refreshMatchingPlugins(session); },
      setUnreachable: (reason) => session.pluginsTree?.applyBackendUnreachable(reason),
    }),
  });

  wireAutoLaunch(session, meditClient, context, outputChannel, toolbox.enterEditing);

  // Exposed for integration tests — unused in production. `client`: a test drives a status
  // transition directly, outside exitEditing. `instance`: lets a test await past a sequence
  // instead of sleeping.
  return {
    folder: toolbox.folder, instanceRead: toolbox.instanceRead,
    modListProvider: toolbox.modListProvider, downloadsProvider: toolbox.downloadsProvider,
    pluginsTree: toolbox.pluginsTree,
    pluginListView: session.pluginsTreeView, treeProvider,
    outputChannel, enterEditing: toolbox.enterEditing, exitEditing: () => exitEditing(session, meditClient),
    client: meditClient, instance: toolbox.instance,
  };
}


interface PluginRowCommandDeps {
  session: ExtensionSession;
  client: HttpMEditClient;
  activeRecordTracker: ActiveRecordTracker<vscode.WebviewPanel>;
  outputChannel: vscode.LogOutputChannel;
  compileDiagnostics: vscode.DiagnosticCollection;
  treeProvider: PluginTreeProvider;
  notifyConflictsComputed: () => void;
  originFiles: OriginFilesOf;
}

// plugins.md, Menus and keys, story 6: the Plugins rows offer rebase edit branch only while no
// rebase is in progress, so a repository's state change re-renders them.
function holdPluginRepositories(session: ExtensionSession, repos: Map<string, MinimalRepository>): void {
  session.pluginRepositoryStates?.dispose();
  session.pluginRepositories = repos;
  session.pluginRepositoryStates = watchRepositoryStates(repos, () => session.pluginsTree?.invalidate());
  session.pluginsTree?.invalidate();
}

// One shared concern, the Plugins-tree row's own context menu, as distinct from the record
// editor's own commands (create/delete/copy — Editor's own registration).
function registerPluginRowCommands(deps: PluginRowCommandDeps): vscode.Disposable[] {
  const { session, client, activeRecordTracker, outputChannel, compileDiagnostics, treeProvider, notifyConflictsComputed, originFiles } = deps;
  const refreshMatchingPluginsFor = () => { void refreshMatchingPlugins(session); };
  return [
    registerTrackCommand(
      { while: (work) => withPluginsViewProgress(session, work), say: (message) => say(session, message) },
      client, outputChannel, makeReporter(outputChannel, 'pluginListTree.track'), treeProvider,
      async () => {
        await registerHeldTrackedRepositories(
          client, outputChannel, (repos) => { holdPluginRepositories(session, repos); }, isTracked, pluginFolder);
        notifyConflictsComputed();
      },
      () => session.pluginsTreeView?.selection ?? [],
    ),
    registerSaveAndCompileCommand(
      client, activeRecordTracker, outputChannel, makeReporter(outputChannel, 'saveAndCompile'), askQuestion,
      compileDiagnostics, originFiles),
    registerCompileAtRefCommand(
      client, outputChannel, makeReporter(outputChannel, 'compileAtMain'), askQuestion,
      compileDiagnostics, originFiles),
    registerRebaseCommand(
      client, outputChannel, makeReporter(outputChannel, 'pluginListTree.rebase'), treeProvider, refreshMatchingPluginsFor, originFiles,
      () => session.pluginsTreeView?.selection ?? []),
    registerOpenHeaderCommand(),
  ];
}


function backendOptions(port: number, channel: vscode.LogOutputChannel): BackendLifecycleOptions {
  // Bundled backend binary (see build:backend / .vscodeignore). __dirname is
  // out/ at runtime; the published self-contained executable lives in backend/.
  const backendExe = process.platform === 'win32' ? 'MEditService.Http.exe' : 'MEditService.Http';
  return {
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
  };
}

function setupScriptsFolder(cfg: vscode.WorkspaceConfiguration): FilterScripts {
  const scriptsPathCfg: string = cfg.get('scriptsPath') ?? '';
  const scriptsPath = scriptsPathCfg || path.join(os.homedir(), '.medit', 'scripts');
  fs.mkdirSync(scriptsPath, { recursive: true });

  return {
    folder: scriptsPath,
    sqlFiles: () => (fs.existsSync(scriptsPath) ? fs.readdirSync(scriptsPath).filter((f) => f.endsWith('.sql')) : []),
    read: (name) => fs.readFileSync(path.join(scriptsPath, name), 'utf8'),
    nameOf: (uri) => path.basename(uri.fsPath),
  };
}


// VS Code's own `deactivate()` takes no arguments, so it has no way to receive what `activate()`
// built — this module-level reference exists solely to bridge that gap.
let activeClient: HttpMEditClient | undefined;

// Async so VS Code awaits confirmed-dead-child teardown before the extension host finishes
// tearing down — otherwise a reload's replacement client is structurally unable to ever clean up
// this instance's spawned child.
export async function deactivate(): Promise<void> {
  await activeClient?.stop();
}

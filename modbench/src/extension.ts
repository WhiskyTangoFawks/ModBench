import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { HttpMEditClient } from './client';
import { announceConflictsComputed, subscribeRecordPanelsToNotifications } from './medit/notificationWiring';
import { PluginTreeProvider } from './plugins/PluginTreeProvider';
import { REFERENCED_BY_VIEW, allHolders, referencedByCopyValueText } from './editor/ReferencedByTreeProvider';
import { createReferencedByView } from './editor/referencedByView';
import { makeReporter } from './reporter';
import { askQuestion } from './dialog';
import { lastSelectedViewSelection } from './treeViews';
import { createFocusedView } from './drivingLib/focusedView';
import { moveToTrash } from './trash';
import { EXTENDED_FIELD_TEMP_ROOT, extendedFieldFile } from './medit/extendedFieldFiles';
import { registerEditorCommands, ActiveRecordTracker, EditsInFlight } from './editor';
import { exitEditing } from './editingTeardown';
import { createToolbox } from './toolbox';
import { registerNameFilter } from './drivingLib/nameFilter';
import type { ExtensionSession } from './session';
import { createStatusBar } from './plugins/statusBar';
import { FocusedCells, GRID_VIEW, focusedCellKeys, gridCopyValueText, type FocusedCellContext } from './editor/focusedCells';
import { meditConfig } from './workspaceConfig';
import { GAME_FOLDER_SETTING } from './instanceAdapter/instanceAdapter';
import {
  registerTrackCommand, registerDecompileCommand, registerCompileCommand, CompileProblems, type CompileDeps, type TrackDeps,
  conflictsComputedOver, refreshSourceControlFor, type PluginsViewProgress,
} from './plugins/pluginRowCommands';
import type { OriginFilesOf } from './instanceLoader/loadOrderSnapshot';
import type { Instance } from './instanceLoader/instance';
import { registerFilterCommands, type FilterScripts } from './plugins/recordFilterCommands';
import { noticeExternalChanges } from './plugins/externalChangeNotice';
import { registerRecordCreateCommand } from './plugins/createRecordCommand';
import { createdRecordSelection } from './plugins/createdRecordSelection';
import { recordWriteOver } from './plugins/recordWrite';
import type { RecordWrite } from './drivingLib/writingGesture';
import { errorMessage } from './ports/errorMessage';
import { modOfRow } from './mods/ModListProvider';
import { MODS_KEY_ARGS } from './mods/gestureEntry';

// The backend launches with the extension (ADR-0002), and a change to the game folder setting is
// its only retry.
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
      if (e.affectsConfiguration(GAME_FOLDER_SETTING) && client.status !== 'running') void launch();
    }),
  );
}

export type ActivateExports = ReturnType<typeof activate>;

export function activate(context: vscode.ExtensionContext) {
  const session: ExtensionSession = {};
  const attachPort = meditConfig().get<number>('attachToBackendPort');

  const outputChannel = vscode.window.createOutputChannel('Modbench', { log: true });
  context.subscriptions.push(outputChannel);
  // `log` is a compat shim (defaults to .info) for modules taking a flat `(msg) => void`.
  const log = (msg: string) => outputChannel.info(msg);

  // Compile's diagnostics — one collection for every tracked mod's source files, in which
  // CompileProblems replaces a plugin's own entries each time it compiles.
  const compileDiagnostics = vscode.languages.createDiagnosticCollection('modbench-compile');
  context.subscriptions.push(compileDiagnostics);

  // ADR-0002.
  const meditClient = new HttpMEditClient({ backend: { attachPort }, backendLog: outputChannel, log });
  activeClient = meditClient; // deactivate()'s only way to reach it
  const statusBar = createStatusBar(meditClient);
  context.subscriptions.push(statusBar);
  const treeProvider = new PluginTreeProvider(meditClient, log);
  const recordPanels = new Set<vscode.WebviewPanel>();
  // The Referenced By view's input — which record panel is active and what FormKey it shows.
  const activeRecordTracker = new ActiveRecordTracker<vscode.WebviewPanel>();
  const editsInFlight = new EditsInFlight(activeRecordTracker);
  const filterScripts = setupScriptsFolder(meditConfig());

  // One subscription for the whole session; the mEdit client opens and closes its stream with the
  // backend.
  context.subscriptions.push(
    { dispose: subscribeRecordPanelsToNotifications(meditClient, recordPanels, activeRecordTracker, editsInFlight) },
  );

  const focusedView = createFocusedView();
  const focusedCells = new FocusedCells<vscode.WebviewPanel>((cell) => {
    for (const [name, value] of Object.entries(focusedCellKeys(cell))) {
      void vscode.commands.executeCommand('setContext', `modbench.record.${name}`, value);
    }
  }, () => focusedView.enter(GRID_VIEW));

  // Fires on every completed reconcile and on a landed Track, the one reliable point to register
  // the tracked repositories.
  const conflictsComputed = conflictsComputedOver(() => announceConflictsComputed(recordPanels, editsInFlight), {
    client: meditClient,
    outputChannel,
    setPluginRepositories: (repos) => { session.pluginRepositories = repos; },
    trackedMods: () => toolbox.instance?.value.trackedMods ?? new Set(),
    modDirs: () => toolbox.instance?.value.paths.modDirs ?? new Map(),
  });
  const notifyConflictsComputed = () => { void conflictsComputed(); };
  const referencedBy = createReferencedByView(meditClient, log, registerNameFilter);
  const { provider: referencedByTreeProvider, view: referencedByTreeView } = referencedBy;
  context.subscriptions.push(
    focusedView.follow(REFERENCED_BY_VIEW, referencedByTreeView),
    referencedByTreeView.onDidChangeSelection(() => {
      void vscode.commands.executeCommand('setContext', 'modbench.referencedBy.allHolders', allHolders(referencedByTreeView.selection));
    }),
  );
  const activeRecordSubscription = activeRecordTracker.onDidChangeActiveRecord(
    (formKey) => referencedByTreeProvider.showFor(formKey));
  // Primes the view with whatever activeRecordTracker already knows — a no-op today, but it makes
  // ActiveRecordTracker.current()'s "initial state" contract true rather than aspirational.
  referencedByTreeProvider.showFor(activeRecordTracker.current());
  const instance = { refresh: () => toolbox.instance?.refresh() ?? Promise.resolve() };
  const recordWrite = recordWriteOver(instance, { latest: () => session.loadOrderSender?.latest() ?? Promise.resolve(undefined) });
  // Its `originFiles` closes over the Toolbox built below and re-reads the value each call, so a
  // compile always asks the generation on screen.
  const pluginRowDeps: PluginRowCommandDeps = {
    session, client: meditClient, outputChannel, compileProblems: new CompileProblems(compileDiagnostics),
    conflictsComputed, instance, recordWrite,
    originFiles: (origin) => toolbox.originFiles(origin),
    instancePlugins: () => toolbox.instance?.value.plugins ?? [],
    instanceMods: () => toolbox.instance?.value.mods ?? [],
    trackSelection: () => toolbox.trackSelection(),
  };
  // The instance side, whole: the Instance, the four views, their gestures and the backend sync.
  const toolbox = createToolbox({
    outputChannel, session, client: meditClient,
    reporterFor: (tag) => makeReporter(outputChannel, tag),
    ask: askQuestion,
    trash: moveToTrash,
    recordBrowser: treeProvider,
    pluginFacts: meditClient,
    statusBar,
    notifyConflictsComputed,
    extensionId: context.extension.id,
    extensionUri: context.extensionUri,
    // Copy value's Referenced By and grid adapters (commands.md, Every view) — the Toolbox owns
    // the command's one registration, alongside the other lists' gestures.
    focusedView,
    viewFilters: new Map([[REFERENCED_BY_VIEW, referencedBy.filter]]),
    referencedByCopyValueText: (clicked, allSelected) => referencedByCopyValueText(referencedByTreeView, clicked, allSelected),
    gridCopyValueText: gridCopyValueText(() => focusedCells.current()),
  });
  const recordViews = [
    { id: REFERENCED_BY_VIEW, view: referencedByTreeView },
    ...(session.plugins ? [{ id: 'modbench.pluginListTree', view: session.plugins.view }] : []),
  ];
  context.subscriptions.push(
    toolbox,
    { dispose: noticeExternalChanges(makeReporter(outputChannel, 'externalChange'), meditClient) },
    referencedBy,
    activeRecordSubscription,
    ...registerPluginRowCommands(pluginRowDeps),
    // The record filter scopes the Plugins tree's own rows — a Plugins-view concern (its module
    // lives under plugins/), so it is wired here rather than inside Editor's own registration.
    ...registerFilterCommands({
      scripts: filterScripts, client: meditClient, treeProvider,
      refreshMatchingPlugins: () => { void session.plugins?.tree.refreshFacts(); },
      showRecordFilter: (filter) => session.plugins?.showRecordFilter(filter),
      reporter: makeReporter(outputChannel, 'recordFilter'),
    }),
    ...registerEditorCommands({
      context, recordPanels, activeRecordTracker, editsInFlight, focusedCells, recordBadgeSource: treeProvider, meditClient, outputChannel,
      refreshPanels: () => announceConflictsComputed(recordPanels, editsInFlight),
      reporterFor: (tag) => makeReporter(outputChannel, tag),
      ask: askQuestion,
      focusedViewSelection: lastSelectedViewSelection(
        (disposable) => { context.subscriptions.push(disposable); return disposable; }, recordViews, 'modbench.record.selectionIn'),
      viewSelections: new Map(recordViews.map(({ id, view }) => [id, () => view.selection])),
      recordWrite,
      refreshSourceControlFor: (plugin, origin) => refreshSourceControlFor(session.pluginRepositories, plugin, origin, outputChannel),
      fieldFile: (field) => extendedFieldFile(EXTENDED_FIELD_TEMP_ROOT, field),
    }),
  );

  wireAutoLaunch(session, meditClient, context, outputChannel, toolbox.enterEditing);

  // Exposed for integration tests — unused in production. `client`: a test drives a status
  // transition directly, outside exitEditing. `instance`: lets a test await past a sequence
  // instead of sleeping.
  return {
    folder: toolbox.folder, instanceRead: toolbox.instanceRead,
    modListProvider: toolbox.modListProvider, downloadsProvider: toolbox.downloadsProvider,
    pluginsTree: toolbox.pluginsTree,
    pluginListView: session.plugins?.view,
    outputChannel, enterEditing: toolbox.enterEditing, exitEditing: () => exitEditing(session, meditClient),
    client: meditClient, instance: toolbox.instance,
    // The record tab in focus reporting its focused cell, as its webview's `focusCell` does.
    focusRecordCell: (cell: FocusedCellContext) => { focusedCells.setActiveCell(cell); },
  };
}


interface PluginRowCommandDeps {
  session: ExtensionSession;
  client: HttpMEditClient;
  outputChannel: vscode.LogOutputChannel;
  compileProblems: CompileProblems;
  conflictsComputed: () => Promise<void>;
  instance: Pick<Instance, 'refresh'>;
  recordWrite: RecordWrite;
  originFiles: OriginFilesOf;
  instancePlugins: TrackDeps['plugins'];
  instanceMods: TrackDeps['mods'];
  trackSelection: () => readonly unknown[];
}

// One shared concern, the Plugins-tree row's own context menu, as distinct from the record
// editor's own commands (delete/copy — Editor's own registration).
function registerPluginRowCommands(deps: PluginRowCommandDeps): vscode.Disposable[] {
  const { session, client, outputChannel, conflictsComputed, instance, instancePlugins, instanceMods, trackSelection } = deps;
  const progress = pluginsProgress(session);
  return [
    registerTrackCommand({
      progress, instance,
      client, reporter: makeReporter(outputChannel, 'mod.track'), onTracked: conflictsComputed,
      plugins: instancePlugins,
      mods: instanceMods,
      modOfRow, modsView: MODS_KEY_ARGS.view,
    }, trackSelection),
    registerDecompileCommand({
      client,
      instance,
      reporter: makeReporter(outputChannel, 'plugin.decompile'),
      ask: askQuestion,
    }, () => session.plugins?.view.selection ?? []),
    registerCompileCommand(compileDeps(deps), () => session.plugins?.view.selection ?? []),
    registerRecordCreateCommand({
      client, reporter: makeReporter(outputChannel, 'record.create'),
      write: deps.recordWrite,
      createdRecords: createdRecordSelection({
        client, reporter: makeReporter(outputChannel, 'record.create'),
        rowOf: (group, formKey) => session.plugins?.tree.recordRow(group, formKey) ?? Promise.resolve(undefined),
        view: { reveal: (row, options) => session.plugins?.view.reveal(row, options) ?? Promise.resolve() },
      }),
    }, () => session.plugins?.view.selection ?? []),
  ];
}

// Outside an instance there is no Plugins view to show the work.
function pluginsProgress(session: ExtensionSession): PluginsViewProgress {
  return {
    while: (work) => session.plugins?.progress.while(work) ?? work(),
    say: (message) => session.plugins?.progress.say(message),
  };
}

function compileDeps(deps: PluginRowCommandDeps): CompileDeps {
  const { client, outputChannel, compileProblems, instance, originFiles } = deps;
  return {
    client,
    instance,
    reporter: makeReporter(outputChannel, 'plugin.compile'),
    problems: compileProblems,
    originFiles,
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

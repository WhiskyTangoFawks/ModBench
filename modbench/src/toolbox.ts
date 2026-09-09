import * as vscode from 'vscode';
import type { MEditClient } from './medit/client';
import { implicitMastersFrom, rebuildIndexVia, putLoadOrderVia } from './toolboxClientCalls';
import { makeReconcileProgressHandler } from './medit/loadOrderProgress';
import { reportLoadOrderResult, syncActiveFilter } from './medit/loadOrderOutcome';
import { PluginTreeProvider } from './plugins/PluginTreeProvider';
import type { CrashRepairOffer, LoadOrderStatus as LoadOrderProgress } from './medit/ApiClient';
import { publishLoadDiagnoses } from './medit/loadDiagnostics';
import { Instance, loadOrderSnapshotOf, wireLoadOrderSyncToInstance } from './modmanager/instance';
import { isMo2Instance } from './modmanager/detectMo2Instance';
import { ModListProvider } from './modmanager/ModListProvider';
import { PluginsTreeProvider, type PluginFactsClient, type PluginsTreeNode, type PluginListSource } from './plugins/PluginsTreeProvider';
import { createLoadOrderSync, type LoadOrderSync } from './loadOrderReconcile';
import { createGameDirectoryResolver, dataFolderFrom } from './modmanager/gameDirectoryResolver';
import { gameReleaseForGame } from './modmanager/mo2/gamePaths';
import type { Reporter } from './modmanager/deployer';
import type { LoadOrderPlugin } from './modmanager/loadOrderSnapshot';
import { DownloadsProvider } from './modmanager/DownloadsProvider';
import { ImplicitMasterDecorationProvider } from './modmanager/ImplicitMasterDecorationProvider';
import { makeReporter } from './reporter';
import { makeRefreshAll } from './refreshAll';
import { ToolboxProvider } from './ToolboxProvider';
import { registerNameFilter, type NameFilter } from './nameFilter';
import { enterEditingAcrossRestarts } from './medit/backendStatus';
import { onPluginCheckboxChanged } from './pluginCheckboxHandler';
import { reconcilePlugins, reorderPlugins, setPluginEnabled, type ImplicitMasterSource, type PluginsCommandResult } from './modmanager/commands/plugins';
import { reconcileMods } from './modmanager/commands/modlist';
import { registerModsReconcile } from './modmanager/modsReconcile';
import { registerPluginsReconcile } from './modmanager/pluginsReconcileTrigger';
import { say, exitEditing } from './editingTeardown';
import { registerModInstallCommands, registerModContextCommands, registerSeparatorCommands, registerCreateEmptyModCommand, registerOverwriteView, registerNotMo2InstanceWelcome, createModListView, registerDownloadsView, registerDeployCommands, registerLaunchCommand, registerModListCoreCommands } from './modmanager/modManagementCommands';
import { onModCheckboxChanged } from './modmanager/modCheckboxHandler';
import { meditConfig, makeDetectPaths, makeDetectWinePrefix, setMo2InstanceContext } from './workspaceConfig';
import { withPluginsViewProgress, type ExtensionSession, type Own } from './session';
import { registerRevealInExplorerCommand, registerCreatePluginCommand } from './plugins/pluginListCommands';

// The port members every gesture, the reconcile and the launch in this file call — narrowed off
// `MEditClient` (ADR-0022), never the controller or the repository.
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
  /** Run the loud crash-repair offer sequence for whatever a completed reconcile found. */
  showCrashRepairOffers: (offers: CrashRepairOffer[]) => Promise<void>;
  /** The malformed-plugin scan's Problems-panel collection. Held on the session so the teardown
   *  writers can clear both diagnosis surfaces together. */
  loadDiagnostics: vscode.DiagnosticCollection;
  /** The one status bar item, written from the reconcile's own outcome — never by the
   *  controller, a lower layer that presents nothing (ADR-0046 invariant 2). */
  setStatusText: (text: string) => void;
  /** Fires on every completed reconcile and on a landed Track: every open record panel refetches
   *  its comparison, and every tracked mod's repo (re-)registers with `vscode.git`. */
  notifyConflictsComputed: () => void;
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
// profile the Instance last landed, and turns a refusal into the rejection ADR-0026's
// notify-and-log path is written against.
function pluginListSource(instanceRoot: string, instance: Instance): PluginListSource {
  return {
    setPluginEnabled: (name, enabled) =>
      applyOrThrow(setPluginEnabled(instanceRoot, instance.value.activeProfile, name, enabled)),
    reorderPlugins: (names, toIndex) =>
      applyOrThrow(reorderPlugins(instanceRoot, instance.value.activeProfile, names, toIndex)),
  };
}

interface PluginListDeps {
  own: Own;
  session: ExtensionSession;
  outputChannel: vscode.LogOutputChannel;
  reporter: Reporter;
  instanceRoot: string;
  // A getter through the single game-directory resolver, not a Promise settled once. Folds a
  // resolution failure to undefined, which leaves an implicit row without a file to point at.
  dataFolder: () => Promise<string | undefined>;
  /** The rows the game forces on, asked of the backend (ADR-0021). */
  implicitMasters: ImplicitMasterSource;
  /** ADR-0047: the tree's only row input — name, origin, slot, enabled and winning for every
   *  plugin copy. */
  instance: Instance;
  /** The record browser that supplies a plugin row's children. */
  recordBrowser: PluginTreeProvider;
  /** Every plugin-keyed fact the tree's badges read. */
  pluginFacts: PluginFactsClient;
  /** The malformed-plugin scan's Problems-panel collection. */
  loadDiagnostics: vscode.DiagnosticCollection;
}

// ADR-0035: one tree, one owner — rows from the Instance, children from the record browser,
// every badge from the facts the provider pulls itself.
function registerPluginListView(deps: PluginListDeps): PluginsTreeProvider {
  const { own, session, outputChannel, reporter, instanceRoot, dataFolder, implicitMasters, instance } = deps;
  // The tree states its own severity (ADR-0026); this routes it to the matching channel level.
  const log = (level: 'info' | 'warn' | 'error', msg: string) => outputChannel[level](msg);
  const source = pluginListSource(instanceRoot, instance);
  const pluginsTree = own(new PluginsTreeProvider({
    instance, source, log, reporter, dataFolder, implicitMasters,
    records: deps.recordBrowser,
    client: deps.pluginFacts,
    publishDiagnoses: (reports) => publishLoadDiagnoses(deps.loadDiagnostics, instanceRoot, reports),
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
  // ADR-0044: the one trigger for a PUT — a landed Instance recompute, never a gesture.
  own(wireLoadOrderSyncToInstance(instance, session.loadOrderSync!));
  own(registerRevealInExplorerCommand(pluginsTree, outputChannel));
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
  /** ADR-0044/ADR-0047: the sync reads its snapshot from this, never from a walk of its own. */
  instance: Instance;
  client: ToolboxClient;
  /** The record browser a reconciled load order refreshes — a different provider from
   *  `session.pluginsTree`, which `applyLoadOrderToTree` below owns. */
  recordBrowser: PluginTreeProvider;
  outputChannel: vscode.LogOutputChannel;
  showCrashRepairOffers: (offers: CrashRepairOffer[]) => Promise<void>;
  setStatusText: (text: string) => void;
  notifyConflictsComputed: () => void;
}

// Not `makeReporter`: its "Modbench: " prefix would double up on the message `syncActiveFilter`
// already builds.
function applySyncedFilterState(
  client: Pick<MEditClient, 'getActiveFilter'>, session: ExtensionSession, outputChannel: vscode.LogOutputChannel,
): Promise<void> {
  return syncActiveFilter(() => client.getActiveFilter(), {
    log: (m) => outputChannel.info(`[toolbox] ${m}`),
    warn: (m) => void vscode.window.showWarningMessage(m),
    setFilterActive: (active, sql, label) => session.setFilterActive?.(active, sql, label),
  });
}

// ADR-0044: the sync an Instance change and a client connect both feed. 250 ms covers a burst
// of Instance recomputes landing close together. `resolveGameDirectory`/`buildSnapshot` read one
// Instance value together (closed over below), never two generations of it.
function makeLoadOrderSync(deps: ReconcileDeps): LoadOrderSync {
  const {
    session, instanceRoot, instance, client, recordBrowser, outputChannel, showCrashRepairOffers,
    setStatusText, notifyConflictsComputed,
  } = deps;
  let snapshot: ReturnType<typeof loadOrderSnapshotOf>;
  return createLoadOrderSync<LoadOrderPlugin, LoadOrderProgress, CrashRepairOffer>({
    debounceMs: 250,
    log: (msg) => outputChannel.debug(msg),
    withProgress: (work) => withPluginsViewProgress(session, work),
    say: (message) => say(session, message),
    logInfo: (msg) => outputChannel.info(msg),
    notifyNoGameDirectory: () => void vscode.window.showErrorMessage(
      'Modbench: No game directory found. Set modbench.mods.gameDirectory to your Stock Game Folder or Steam install.',
    ),
    resolveGameDirectory: () => {
      snapshot = loadOrderSnapshotOf(instance.value);
      return Promise.resolve(snapshot ? { dataFolder: snapshot.dataFolder } : undefined);
    },
    buildSnapshot: () => Promise.resolve(snapshot?.plugins ?? []),
    makeProgressHandler: () => makeTreeProgressHandler(session),
    // A release the table can't translate is sent as MO2's own spelling rather than a guess: the
    // backend then rejects it visibly instead of quietly answering about the wrong game.
    putLoadOrder: async (plugins, dataFolder, signal, onProgress) => {
      const result = await putLoadOrderVia(
        client, plugins, dataFolder, instanceRoot,
        gameReleaseForGame(instance.value.gameRelease) ?? instance.value.gameRelease,
        { onProgress, signal },
      );
      reportLoadOrderResult(plugins, result, {
        log: (m) => outputChannel.info(`[toolbox] ${m}`),
        warn: (m) => void vscode.window.showWarningMessage(m),
        error: (m) => void vscode.window.showErrorMessage(m),
        setStatusText,
        refreshTree: () => recordBrowser.refresh(),
        notifyConflictsComputed,
      });
      return result;
    },
    syncFilterState: () => applySyncedFilterState(client, session, outputChannel),
    applyReconciled: (failures, totalPlugins) => applyLoadOrderToTree(session, failures, outputChannel, totalPlugins),
    presentCrashRepairOffers: (offers) => showCrashRepairOffers(offers),
  });
}

// ADR-0035: rows gain chevrons here — and *finish* gaining them here. The tree reads the
// backend's own plugin list itself; the failures the toast inside putLoadOrder already consumed
// ride along rather than being re-derived.
async function applyLoadOrderToTree(
  session: ExtensionSession,
  failures: { name?: string | null; reason?: string | null }[],
  outputChannel: vscode.LogOutputChannel,
  // Carried in only to be logged next to what reached the tree. Deliberately not `plugins.length`
  // from the caller's snapshot: that omits the implicit masters the backend prepends, so every
  // healthy reconcile would read as short.
  totalPlugins: number,
): Promise<void> {
  const held = await session.pluginsTree?.applyReconciled(failures);
  if (held === undefined) {
    // Leaving every row a leaf is a safe *render* but not an honest one: the reconcile did land,
    // so the tree would claim editing is unavailable with nothing on screen to say why (ADR-0026).
    outputChannel.error('[toolbox] the reconciled load order did not reach the tree; plugin rows will not expand');
    void vscode.window.showWarningMessage(
      'Modbench: The load order was reconciled, but the plugin list could not be read — plugin rows will not expand into records. Close and relaunch mEdit to retry.',
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
function makeTreeProgressHandler(
  session: ExtensionSession,
): { onProgress: (status: LoadOrderProgress) => void; lastTotalPlugins: () => number } {
  let totalPlugins = 0;
  const applyTick = makeReconcileProgressHandler({
    applyLoadOrder: (indexedPlugins, failures) => session.pluginsTree?.applyIndexed(indexedPlugins, failures),
  });
  return {
    onProgress: (status) => { totalPlugins = status.totalPlugins; applyTick(status); },
    lastTotalPlugins: () => totalPlugins,
  };
}

// `loadOrderSync.arm()` returns a pure check — it cannot hold an `outputChannel` (ADR-0044) — so
// each call site logs explicitly instead.
function reportAbandoned(outputChannel: vscode.LogOutputChannel): void {
  outputChannel.info('[toolbox] the reconcile was abandoned before it landed; leaving the closed view alone');
}

// ADR-0035: owns its own progress indicator rather than leaving each caller to wrap it, and
// reports its steps through `say`.
function makeEnterEditing(
  session: ExtensionSession, instance: Instance, client: ToolboxClient,
  outputChannel: vscode.LogOutputChannel, revealLog: () => void,
): () => Promise<void> {
  const enter = async (): Promise<void> => {
    const { abandoned } = session.loadOrderSync!.arm();
    // Overlaps with the backend starting below, same as the tree's own first-value
    // wait: `flush()` must read a real Instance value, never the empty pre-first-read sentinel.
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
      void vscode.window.showErrorMessage('Modbench: Backend failed to start — see the Modbench output for details.');
      return;
    }
    await instanceReady;
    // No game directory means nothing to build a snapshot from — don't strand the UI in an empty
    // editing view. `flush()` is used because this path wants the outcome, not just a promise.
    if ((await session.loadOrderSync!.flush()) === 'no-game-directory') exitEditing(session, client);
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
    outputChannel, session, client, recordBrowser, pluginFacts, loadDiagnostics, showCrashRepairOffers,
    setStatusText, notifyConflictsComputed,
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
  // error tree node (ADR-0026).
  if (!isMo2Instance(instanceRoot)) {
    own(registerNotMo2InstanceWelcome(instanceRoot, outputChannel));
    return undefined;
  }
  setMo2InstanceContext(true);
  const modListReporter = makeReporter(outputChannel, 'modList');
  // Memoised, and invalidated only when modbench.mods.gameDirectory changes, so no consumer can
  // disagree about which folder is current. Deliberately not an activation-scoped Promise
  // resolved once.
  const detectPaths = makeDetectPaths(instanceRoot);
  const detectWinePrefix = makeDetectWinePrefix(instanceRoot);
  const gameDirResolver = own(createGameDirectoryResolver(
    instanceRoot, meditConfig, detectPaths, detectWinePrefix, vscode.workspace.onDidChangeConfiguration));
  // Never rejects: a null resolution and a misconfigured setting both fold to undefined, so the
  // views degrade rather than throw. Memoised by the resolver's cache generation, so a
  // stuck-broken setting logs once instead of once per visible file.
  const dataFolder = dataFolderFrom(gameDirResolver, (e) =>
    outputChannel.error(`[toolbox] resolving the game directory failed: ${e instanceof Error ? e.message : String(e)}`));
  // ADR-0047: the one Instance over MO2's files, its own watchers and game-directory
  // resolution included — a second, independent resolution from the memoised one above.
  const instance = own(new Instance({
    instanceRoot, log,
    config: meditConfig, detectPaths, detectWinePrefix, onConfigChange: vscode.workspace.onDidChangeConfiguration,
  }));
  // Fire-and-forget: watchers alone leave the value at its EMPTY sentinel until a change, so
  // this kicks off the first real read. The Plugins tree's own `sequence === 0` guard is
  // what keeps activation from being blocking here.
  void instance.refresh();
  // ADR-0047: rows, statuses and the overwrite count all come from the Instance value now —
  // this provider builds no index and reads no disk of its own.
  const modListProvider = own(new ModListProvider({ instance, log, instanceRoot, reporter: modListReporter }));
  // ADR-0044: built before the Plugins tree, because both the tree's hasMatchingRecords accessor
  // and enterEditing below need the session slot filled first.
  session.loadOrderSync = own(makeLoadOrderSync({
    session, instanceRoot, instance, client, recordBrowser, outputChannel, showCrashRepairOffers,
    setStatusText, notifyConflictsComputed,
  }));
  // The backend answers this, never the extension (ADR-0021), and it needs both the Data folder
  // and the game. An unresolved folder, a game with no Mutagen release, and an unreachable
  // backend are one answer: unknown.
  const implicitMastersIn = (folder: string | undefined, gameName: string): Promise<string[] | undefined> =>
    implicitMastersFrom(client, folder, gameReleaseForGame(gameName));
  // plugins.txt converges on what disk provides; the write reaches the Plugins tree and Editing's
  // Plugin load order sync through the plugins.txt watcher.
  const runPluginsReconcile = async (profile: string, folder: string | undefined, gameName: string) => {
    const result = await reconcilePlugins(
      instanceRoot, profile, folder, () => implicitMastersIn(folder, gameName),
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
    own, session, outputChannel, reporter: makeReporter(outputChannel, 'pluginList'), instanceRoot, dataFolder,
    implicitMasters: async () => implicitMastersIn(await dataFolder(), instance.value.gameRelease),
    instance, recordBrowser, pluginFacts, loadDiagnostics,
  });
  const { modListView, updateProfileDescription } = createModListView(own, modListProvider, instance);
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
          `arrangement; Modbench does not run the installer's own install steps.`,
      );
  };
  const { enter: enterEditing } = own(enterEditingAcrossRestarts(
    client,
    makeEnterEditing(session, instance, client, outputChannel, () => outputChannel.show(true)),
    (msg) => outputChannel.error(`[toolbox] ${msg}`),
  ));
  own(modListView.onDidChangeCheckboxState((e) => onModCheckboxChanged(e, modListProvider, outputChannel)));
  ownAll(own, registerModListCoreCommands(instanceRoot, modListProvider, instance, outputChannel, updateProfileDescription));
  ownAll(own, registerDeployCommands(instanceRoot, instance, outputChannel, gameDirResolver));
  own(registerLaunchCommand(outputChannel));
  ownAll(own, registerModInstallCommands({ instanceRoot, runModAction, promptModName, warnIfFomod }));
  ownAll(own, registerModContextCommands(instanceRoot, instance, outputChannel, runModAction));
  ownAll(own, registerSeparatorCommands(instanceRoot, instance, runModAction));
  own(registerCreateEmptyModCommand(instanceRoot, instance, runModAction));
  ownAll(own, registerOverwriteView(instanceRoot, modListProvider, outputChannel));
  own(registerModsReconcile(
    instanceRoot, () => reconcileMods(instanceRoot, instance.value.activeProfile),
    () => modListProvider.invalidate(), outputChannel));
  own(registerPluginsReconcile(instance, runPluginsReconcile));
  const downloadsProvider = registerDownloadsView(own, instanceRoot, instance, outputChannel);
  // ADR-0046: rebuild before resend before the tree re-reads (refreshAll.ts owns the sequence);
  // a rebuild failure is reported through makeReporter, never a bare toast (modbench/CLAUDE.md).
  const refreshAll = makeRefreshAll({
    rebuildIndex: () => rebuildIndexVia(
      client, instanceRoot,
      (message, detail) => makeReporter(outputChannel, 'refresh').report('error', message, detail),
      gameReleaseForGame(instance.value.gameRelease) ?? instance.value.gameRelease,
    ),
    sendLoadOrder: () => session.loadOrderSync!.flush(),
    // The Mods tree renders the Instance's value now (ADR-0047): force a real re-read of disk,
    // not just a re-render of whatever the Instance last landed.
    invalidateMods: () => { void instance.refresh(); modListProvider.invalidate(); },
    // Same as invalidateMods above: Plugins renders the Instance value too (ADR-0047).
    invalidatePlugins: () => { void instance.refresh(); pluginsTree.invalidate(); },
    // Same as invalidatePlugins above: Downloads renders the Instance value too (ADR-0047).
    invalidateDownloads: () => { void instance.refresh(); downloadsProvider.invalidate(); },
    updateProfileDescription,
  });
  return { instance, instanceRoot, modListProvider, downloadsProvider, pluginsTree, refreshAll, enterEditing };
}

const ownAll = (own: Own, disposables: vscode.Disposable[]): void => {
  for (const disposable of disposables) own(disposable);
};

export function createToolbox(deps: ToolboxDeps): Toolbox {
  const { outputChannel, client } = deps;
  const owned: vscode.Disposable[] = [];
  const own: Own = (disposable) => {
    owned.push(disposable);
    return disposable;
  };

  const mo2 = buildMo2Side(own, deps);

  // ADR-0047: the view's rows are the Instance's value. The provider holds no state and reads
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
  own(registerCreatePluginCommand(client, mo2, outputChannel));

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

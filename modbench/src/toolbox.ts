import * as vscode from 'vscode';
import type {
  CrashRepairOffer, LoadOrderStatus as LoadOrderProgress, MEditClient, PluginLoadFailure,
} from './medit/client';
import { createLoadOrderSender } from './medit/client';
import { implicitMastersFrom, rebuildIndexVia } from './toolboxClientCalls';
import { makeReconcileProgressHandler } from './medit/loadOrderProgress';
import { applyLoadOrderOutcome, syncActiveFilter } from './medit/loadOrderOutcome';
import { PluginTreeProvider } from './plugins/PluginTreeProvider';
import { publishLoadDiagnoses } from './medit/loadDiagnostics';
import { Instance, loadOrderSnapshotOf } from './modmanager/instance';
import { isMo2Instance } from './modmanager/detectMo2Instance';
import { ModListProvider } from './modmanager/ModListProvider';
import { PluginsTreeProvider, type PluginFactsClient, type PluginsTreeNode, type PluginListSource } from './plugins/PluginsTreeProvider';
import { gameReleaseForGame } from './modmanager/mo2/gamePaths';
import { makeReporter, type Reporter } from './reporter';
import { originFolder } from './modmanager/loadOrderSnapshot';
import { DownloadsProvider } from './modmanager/DownloadsProvider';
import { ImplicitMasterDecorationProvider } from './modmanager/ImplicitMasterDecorationProvider';
import { makeRefreshAll } from './refreshAll';
import { ToolboxProvider } from './ToolboxProvider';
import { registerNameFilter, type NameFilter } from './nameFilter';
import { enterEditingAcrossRestarts } from './medit/backendStatus';
import { onPluginCheckboxChanged } from './pluginCheckboxHandler';
import { reconcilePlugins, reorderPlugins, setPluginEnabled, type ImplicitMasterSource, type PluginsCommandResult } from './modmanager/commands/plugins';
import { adoptMods } from './modmanager/commands/modlist';
import { registerModAdoption } from './modmanager/modAdoptionTrigger';
import { registerPluginsReconcile } from './modmanager/pluginsReconcileTrigger';
import { say, exitEditing } from './editingTeardown';
import { registerModInstallCommands, registerModContextCommands, registerSeparatorCommands, registerCreateEmptyModCommand, registerOverwriteView, registerNotMo2InstanceWelcome, createModListView, registerDownloadsView, registerModListCoreCommands } from './modmanager/modManagementCommands';
import { deployMods, purgeMods, type DeploymentCommandResult } from './modmanager/commands/deployment';
import { listProfiles, switchProfile } from './modmanager/commands/profile';
import { onModCheckboxChanged } from './modmanager/modCheckboxHandler';
import { meditConfig, makeDetectPaths, makeDetectWinePrefix, setMo2InstanceContext } from './workspaceConfig';
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
  /** Run the loud crash-repair offer sequence for whatever a completed reconcile found. */
  showCrashRepairOffers: (offers: CrashRepairOffer[]) => Promise<void>;
  /** The malformed-plugin scan's Problems-panel collection. Held on the session so the teardown
   *  writers can clear both diagnosis surfaces together. */
  loadDiagnostics: vscode.DiagnosticCollection;
  /** The one status bar item, written from the reconcile's own outcome — never by the
   *  controller, a lower layer that presents nothing (ADR-0014 invariant 1). */
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
// profile the Instance last landed, and turns a refusal into the rejection ADR-0019's
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
  const { own, session, outputChannel, reporter, instanceRoot, dataFolder, implicitMasters, instance } = deps;
  // The tree states its own severity (ADR-0019); this routes it to the matching channel level.
  const log = (level: 'info' | 'warn' | 'error', msg: string) => outputChannel[level](msg);
  const source = pluginListSource(instanceRoot, instance);
  const pluginsTree = own(new PluginsTreeProvider({
    instance, source, log, reporter, dataFolder, implicitMasters,
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
  /** ADR-0013/ADR-0015: the snapshot is read from this, never from a walk of its own. */
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

// ADR-0013: one landed Instance value becomes one snapshot; the client's sender owns what
// happens to it from there, and what comes back is reported and applied here.
function makeReconcile(deps: ReconcileDeps): () => Promise<void> {
  const {
    session, instanceRoot, instance, client, recordBrowser, outputChannel, showCrashRepairOffers,
    setStatusText, notifyConflictsComputed,
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
    // A release the table can't translate is sent as MO2's own spelling rather than a guess: the
    // backend then rejects it visibly instead of quietly answering about the wrong game.
    const result = await session.loadOrderSender!.send({
      plugins,
      gameDirectory: dataFolder,
      instanceRoot,
      gameRelease: gameReleaseForGame(instance.value.gameRelease) ?? instance.value.gameRelease,
    }, { onProgress: treeProgress.onProgress });
    await applyLoadOrderOutcome(plugins, result, treeProgress.lastTotalPlugins(), {
      log: (m) => outputChannel.info(`[toolbox] ${m}`),
      warn: (m) => void vscode.window.showWarningMessage(m),
      error: (m) => void vscode.window.showErrorMessage(m),
      setStatusText,
      refreshTree: () => recordBrowser.refresh(),
      notifyConflictsComputed,
      syncFilterState: () => applySyncedFilterState(client, session, outputChannel),
      applyReconciled: (failures, totalPlugins) => applyLoadOrderToTree(session, failures, outputChannel, totalPlugins),
      presentCrashRepairOffers: (offers) => showCrashRepairOffers(offers),
    });
  };
  // A snapshot handed over before mEdit is attached waits on the client for the connect, so
  // narrating it would leave the Plugins view spinning on a load nobody has asked for yet.
  return () => (client.status === 'attached' ? withPluginsViewProgress(session, run) : run());
}

// ADR-0002: rows gain chevrons here — and *finish* gaining them here. The tree reads the
// backend's own plugin list itself; the failures the toast inside putLoadOrder already consumed
// ride along rather than being re-derived.
async function applyLoadOrderToTree(
  session: ExtensionSession,
  failures: PluginLoadFailure[],
  outputChannel: vscode.LogOutputChannel,
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

// `loadOrderSender.arm()` returns a pure check — it cannot hold an `outputChannel` (ADR-0013) —
// so each call site logs explicitly instead.
function reportAbandoned(outputChannel: vscode.LogOutputChannel): void {
  outputChannel.info('[toolbox] the reconcile was abandoned before it landed; leaving the closed view alone');
}

// ADR-0002: owns its own progress indicator rather than leaving each caller to wrap it, and
// reports its steps through `say`.
function makeEnterEditing(
  session: ExtensionSession, instance: Instance, client: ToolboxClient,
  outputChannel: vscode.LogOutputChannel, revealLog: () => void, reconcile: () => Promise<void>,
): () => Promise<void> {
  const enter = async (): Promise<void> => {
    const { abandoned } = session.loadOrderSender!.arm();
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
      void vscode.window.showErrorMessage('Modbench: Backend failed to start — see the Modbench output for details.');
      return;
    }
    await instanceReady;
    // No game directory means no snapshot to hand over — don't strand the UI in an empty editing
    // view. This is the one path that asked for a load order, so this is where it is reported.
    if (!loadOrderSnapshotOf(instance.value)) {
      void vscode.window.showErrorMessage(
        'Modbench: No game directory found. Set modbench.mods.gameDirectory to your Stock Game Folder or Steam install.',
      );
      exitEditing(session, client);
      return;
    }
    await reconcile();
  };
  return () => withPluginsViewProgress(session, enter);
}


/** The task type tool launching contributes one task per MO2 executables-registry entry under.
 *  Named here so the provider and the Launch… command have one place to agree. */
export const LAUNCH_TASK_TYPE = 'modbench';

interface ToolboxCommandDeps {
  instanceRoot: string;
  /** ADR-0015: the profile, the game directory and the file winners all come from the value. */
  instance: Pick<Instance, 'value'>;
  outputChannel: vscode.LogOutputChannel;
  updateProfileDescription: () => Promise<void>;
}

// `wrote` false means the command reported its own abort, so the success message is withheld
// rather than announcing a deployment that did not happen.
async function runDeployment(
  reporter: Reporter, failure: string, success: string, command: () => Promise<DeploymentCommandResult>,
): Promise<void> {
  let outcome: DeploymentCommandResult;
  try {
    outcome = await command();
  } catch (err) {
    outcome = { applied: false, refusal: err instanceof Error ? err.message : String(err) };
  }
  if (!outcome.applied) {
    reporter.report('error', failure, outcome.refusal);
    return;
  }
  if (!outcome.wrote) return;
  // The manifest lands under mods/, which the Instance watches — its own recompute is what moves
  // the Toolbox's deployment row, never this command.
  void vscode.window.showInformationMessage(success);
}

// The four instance-wide gestures the Toolbox view owns (docs/specs/containers.md rule 1),
// registered from the box that draws them.
function registerToolboxCommands(deps: ToolboxCommandDeps): vscode.Disposable[] {
  const { instanceRoot, instance, outputChannel, updateProfileDescription } = deps;
  const detectPaths = makeDetectPaths(instanceRoot);
  const deployReporter = makeReporter(outputChannel, 'deploy');
  const loadOrderTarget = async (): Promise<string | undefined> =>
    meditConfig().get('game.pluginsTxtPath') || (await detectPaths())?.pluginsTxt;

  return [
    vscode.commands.registerCommand('modbench.toolbox.switchProfile', async () => {
      const active = instance.value.activeProfile;
      const profiles = await listProfiles(instanceRoot);
      const picked = await vscode.window.showQuickPick(
        profiles.map((p) => ({ label: p, description: p === active ? 'current' : undefined })),
        { placeHolder: 'Switch profile' },
      );
      if (!picked || picked.label === active) return;
      const outcome = await switchProfile(instanceRoot, picked.label);
      if (!outcome.applied) {
        makeReporter(outputChannel, 'switchProfile').report('error', 'Failed to switch profile.', outcome.refusal);
        return;
      }
      void updateProfileDescription();
      // ADR-0013/ADR-0015: the write lands in ModOrganizer.ini, which the Instance already
      // watches — its own recompute reaches the load order and the Toolbox's profile row.
    }),
    vscode.commands.registerCommand('modbench.toolbox.deploy', () =>
      runDeployment(deployReporter, 'Deploy failed.', 'Modbench: Mods deployed.', async () =>
        deployMods(
          instanceRoot,
          instance.value.activeProfile,
          instance.value.files,
          instance.value.gameDirectory,
          await loadOrderTarget(),
          deployReporter,
          (message, options, ...items) => vscode.window.showWarningMessage(message, options, ...items),
        ))),
    vscode.commands.registerCommand('modbench.toolbox.purge', () =>
      runDeployment(deployReporter, 'Purge failed.', 'Modbench: Deployed mods purged.', () =>
        purgeMods(instanceRoot, instance.value.gameDirectory, deployReporter))),
    // One affordance however many executables exist, because MO2's registry decides what is
    // launchable. Tasks are read at invocation, so an executable added in MO2 appears without a
    // reload; resolving a binary here would lock the command to one game.
    vscode.commands.registerCommand('modbench.toolbox.launch', async () => {
      const tasks = await vscode.tasks.fetchTasks({ type: LAUNCH_TASK_TYPE });
      if (tasks.length === 0) {
        outputChannel.info('[toolbox] Launch…: no launchable tasks contributed');
        void vscode.window.showInformationMessage(
          'Modbench: No launch targets — add an executable to MO2\'s executables list and it appears here.',
        );
        return;
      }
      const picked = await vscode.window.showQuickPick(
        tasks.map((task) => ({ label: task.name, task })),
        { placeHolder: 'Launch' },
      );
      if (!picked) return;
      await vscode.tasks.executeTask(picked.task);
    }),
  ];
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
  // error tree node (ADR-0019).
  if (!isMo2Instance(instanceRoot)) {
    own(registerNotMo2InstanceWelcome(instanceRoot, outputChannel));
    return undefined;
  }
  setMo2InstanceContext(true);
  const modListReporter = makeReporter(outputChannel, 'modList');
  const detectPaths = makeDetectPaths(instanceRoot);
  const detectWinePrefix = makeDetectWinePrefix(instanceRoot);
  // ADR-0015: the one Instance over MO2's files, its own watchers and its game-directory
  // resolution included — the only resolution there is.
  const instance = own(new Instance({
    instanceRoot, log,
    config: meditConfig, detectPaths, detectWinePrefix, onConfigChange: vscode.workspace.onDidChangeConfiguration,
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
  // ADR-0013: built before the Plugins tree, because both the tree's hasMatchingRecords accessor
  // and enterEditing below need the session slot filled first.
  session.loadOrderSender = own(createLoadOrderSender(client));
  const reconcile = makeReconcile({
    session, instanceRoot, instance, client, recordBrowser, outputChannel, showCrashRepairOffers,
    setStatusText, notifyConflictsComputed,
  });
  // The backend answers this, never the extension (ADR-0016), and it needs both the Data folder
  // and the game. An unresolved folder, a game with no Mutagen release, and an unreachable
  // backend are one answer: unknown.
  const implicitMastersIn = (folder: string | undefined, gameName: string): Promise<string[] | undefined> =>
    implicitMastersFrom(client, folder, gameReleaseForGame(gameName));
  // plugins.txt converges on what disk provides; the write reaches the Plugins tree and Editing's
  // Plugin load order sync through the plugins.txt watcher.
  const runPluginsReconcile = async (
    profile: string, provided: ReadonlyMap<string, string>, folder: string | undefined, gameName: string,
  ) => {
    const result = await reconcilePlugins(
      instanceRoot, profile, provided, folder, () => implicitMastersIn(folder, gameName),
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
  const promptModName = (defaultName: string, validateInput?: (value: string) => string | undefined) =>
    vscode.window.showInputBox({ prompt: 'Mod name', value: defaultName, validateInput });
  const warnIfFomod = (name: string, isFomod: boolean) => {
    if (isFomod)
      void vscode.window.showWarningMessage(
        `Modbench: "${name}" is a FOMOD installer — its files were copied as-is and need manual ` +
          `arrangement; Modbench does not run the installer's own install steps.`,
      );
  };
  const { enter: enterEditing } = own(enterEditingAcrossRestarts(
    client,
    makeEnterEditing(session, instance, client, outputChannel, () => outputChannel.show(true), reconcile),
    (msg) => outputChannel.error(`[toolbox] ${msg}`),
  ));
  // ADR-0013: the one trigger for a PUT — a landed Instance recompute, never a gesture. A throw
  // in the applied outcome is logged here, because no caller is left to hear it.
  own(instance.subscribe(() => void reconcile().catch((e: unknown) => outputChannel.error(
    `[toolbox] handing mEdit the load order threw: ${e instanceof Error ? e.message : String(e)}`))));
  own(modListView.onDidChangeCheckboxState((e) => onModCheckboxChanged(e, modListProvider, outputChannel)));
  ownAll(own, registerModListCoreCommands(modListProvider));
  ownAll(own, registerToolboxCommands({
    instanceRoot, instance, outputChannel, updateProfileDescription,
  }));
  ownAll(own, registerModInstallCommands({ instanceRoot, instance, runModAction, promptModName, warnIfFomod }));
  ownAll(own, registerModContextCommands(instanceRoot, instance, outputChannel, runModAction));
  ownAll(own, registerSeparatorCommands(instanceRoot, instance, runModAction));
  own(registerCreateEmptyModCommand(instanceRoot, instance, runModAction));
  ownAll(own, registerOverwriteView(instanceRoot, outputChannel));
  own(registerModAdoption(
    instance, (profile, unlistedFolders) => adoptMods(instanceRoot, profile, unlistedFolders),
    () => modListProvider.invalidate(), outputChannel));
  own(registerPluginsReconcile(instance, runPluginsReconcile));
  const downloadsProvider = registerDownloadsView(own, instanceRoot, instance, outputChannel);
  // ADR-0014: rebuild before resend before the tree re-reads (refreshAll.ts owns the sequence);
  // a rebuild failure is reported through makeReporter, never a bare toast (modbench/CLAUDE.md).
  const refreshAll = makeRefreshAll({
    rebuildIndex: () => rebuildIndexVia(
      client, instanceRoot,
      (message, detail) => makeReporter(outputChannel, 'refresh').report('error', message, detail),
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
  const { outputChannel, client } = deps;
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

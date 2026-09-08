import * as vscode from 'vscode';
import { detectWinePrefix } from './medit/GamePathDetector';
import { EditingController, type LoadOrderProgress } from './medit/EditingController';
import { makeReconcileProgressHandler } from './medit/loadOrderProgress';
import { PluginTreeNode, PluginTreeProvider } from './medit/PluginTreeProvider';
import type { CrashRepairOffer, PluginDiagnosisReport } from './medit/ApiClient';
import { publishLoadDiagnoses, groupDiagnosesByPlugin } from './medit/loadDiagnostics';
import { Instance, loadOrderSnapshotOf, wireLoadOrderSyncToInstance } from './modmanager/instance';
import { isMo2Instance } from './modmanager/detectMo2Instance';
import { ModListProvider } from './modmanager/ModListProvider';
import { PluginListProvider, pluginFileOf, orderIssueMastersOf, type PluginListNode, type PluginListSource } from './modmanager/PluginListProvider';
import { PluginsTreeComposite, type PluginFacts } from './PluginsTreeComposite';
import { createLoadOrderSync, type LoadOrderSync } from './loadOrderReconcile';
import { createGameDirectoryResolver, dataFolderFrom } from './modmanager/gameDirectoryResolver';
import type { Reporter } from './modmanager/deployer';
import type { LoadOrderPlugin } from './modmanager/loadOrderSnapshot';
import { resolvePluginDestination, type PluginDestinationChoice } from './modmanager/pluginDestination';
import { DownloadsProvider } from './modmanager/DownloadsProvider';
import { ImplicitMasterDecorationProvider } from './modmanager/ImplicitMasterDecorationProvider';
import { makeReporter } from './reporter';
import { makeRefreshAll } from './refreshAll';
import { ToolboxProvider } from './ToolboxProvider';
import { registerNameFilter, type NameFilter } from './nameFilter';
import { onPluginCheckboxChanged } from './pluginCheckboxHandler';
import { appendPlugin, reconcilePlugins, reorderPlugins, setPluginEnabled, type PluginsCommandResult } from './modmanager/commands/plugins';
import { createEmptyMod, reconcileMods } from './modmanager/commands/modlist';
import { registerModsReconcile } from './modmanager/modsReconcile';
import { registerPluginsReconcile } from './modmanager/pluginsReconcileTrigger';
import { say, clearTreeWhenBackendDies, exitEditing } from './editingTeardown';
import { registerModInstallCommands, registerModContextCommands, registerSeparatorCommands, registerCreateEmptyModCommand, registerOverwriteView, registerNotMo2InstanceWelcome, createModListView, registerDownloadsView, isStandaloneDeployment, registerDeploymentModeContext, registerDeployCommands, registerLaunchCommand, registerModListCoreCommands } from './modmanager/modManagementCommands';
import { onModCheckboxChanged } from './modmanager/modCheckboxHandler';
import { meditConfig, makeDetectPaths, setMo2InstanceContext } from './workspaceConfig';
import { withPluginsViewProgress, type ExtensionSession, type Own } from './session';

// Which plugin files Editing's load order names — the backend's own list, not the snapshot we
// sent, because the backend prepends implicit masters. Keyed by filename, reading the
// `inLoadOrder` copy: two held copies can share one (ADR-0044).
export interface HeldPluginFiles {
  files: Set<string>;
  readOnly: Set<string>;
  /** What the composite decorates each row from, keyed by filename — see `PluginFacts`. */
  facts: Map<string, PluginFacts>;
  /** Lowercased filename → does this plugin own a record the *current* record filter matches.
   *  Carried in this hand-off because every reconcile reaches it downstream of `syncFilterState()`,
   *  so the map never outlives the filter state it describes. */
  matches: Map<string, boolean>;
  /** Which of those plugins are tracked — their mod folder holds a `.git` (ADR-0041). A `.git`
   *  appearing or vanishing is itself a `mods/**` watcher event, which is what makes tracking
   *  reach the rows without a reload. */
  tracked: Set<string>;
}

export interface ToolboxDeps {
  outputChannel: vscode.LogOutputChannel;
  session: ExtensionSession;
  controller: EditingController;
  /** The record browser the Plugins tree's rows expand into. Built by the editing side, which
   *  owns the single instance both plugin trees read through. */
  recordBrowser: PluginTreeProvider;
  /** The plugin files the backend's load order names, for deciding which rows can expand. */
  heldPluginFiles: () => Promise<HeldPluginFiles>;
  /** Run the loud crash-repair offer sequence for whatever a completed reconcile found. */
  showCrashRepairOffers: (offers: CrashRepairOffer[]) => Promise<void>;
  /** Fetch the session-load malformed-plugin scan and publish it. Held on the session so the
   *  teardown writers can clear both diagnosis surfaces together. */
  loadDiagnostics: vscode.DiagnosticCollection;
  /** The backend's session-load malformed-plugin scan, read once per landed reconcile. */
  getDiagnoses: () => Promise<PluginDiagnosisReport[]>;
}

/** The Toolbox: the view of the instance, and the MO2 side's composition root. Everything below
 *  `modbench.toolbox` in the container is built here and torn down with it. */
export interface Toolbox extends vscode.Disposable {
  /** Absent together, on the paths with no MO2 instance to read. Exposed for integration
   *  tests — production reaches all of these through the views. */
  modListProvider?: ModListProvider;
  downloadsProvider?: DownloadsProvider;
  pluginListProvider?: PluginListProvider;
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
  // resolution failure to undefined, degrading vanilla-master lookups and badges.
  dataFolder: () => Promise<string | undefined>;
  /** ADR-0047: the row provider's only row input — name, origin, slot, enabled and winning for
   *  every plugin copy. */
  instance: Instance;
  /** The record browser that supplies a plugin row's children. Passed as the composite's
   *  child source and never touched directly here. */
  recordBrowser: PluginTreeProvider;
}
// ADR-0035: the view is a `PluginsTreeComposite` over two providers — these rows and the record
// browser's children — so each row expands into its records. The composition root is the only
// place that may know both.
function registerPluginListView(deps: PluginListDeps): PluginListProvider {
  const { own, session, outputChannel, reporter, instanceRoot, dataFolder, instance, recordBrowser } = deps;
  // `log` is a compat shim (defaults to .info) for modules taking a flat `(msg) => void`.
  const log = (msg: string) => outputChannel.info(msg);
  const source = pluginListSource(instanceRoot, instance);
  const pluginListProvider = own(new PluginListProvider({ instance, source, log, reporter, dataFolder }));
  const composite = own(new PluginsTreeComposite<PluginListNode, PluginTreeNode>({
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
  }));
  session.pluginsTree = composite;
  clearTreeWhenBackendDies(session, composite, recordBrowser);
  const pluginListView = own(vscode.window.createTreeView('modbench.pluginListTree', {
    treeDataProvider: composite,
    canSelectMany: true,
    // Still the row provider's: a drag moves plugins.txt lines, which is a Mod-Management
    // concern whether or not the rows happen to have children today.
    dragAndDropController: pluginListProvider,
    // Title-bar rule 7 (docs/specs/containers.md): hierarchical trees get Collapse All, and this
    // one is hierarchical — plugin → record type → record.
    showCollapseAll: true,
  }));
  session.pluginsTreeView = pluginListView; // progress and message live here
  session.pluginsNameFilter = own(registerPluginsNameFilter(pluginListView, pluginListProvider));
  // Grays an implicit master's row the way MO2 grays COL_NAME for a forceLoaded plugin — live
  // against PluginListProvider's own implicitMasterNames() so it never drifts from the tree.
  own(vscode.window.registerFileDecorationProvider(
    new ImplicitMasterDecorationProvider(dataFolder, () => pluginListProvider.implicitMasterNames()),
  ));
  own(pluginListView.onDidChangeCheckboxState((e) => onPluginCheckboxChanged(e, pluginListProvider, outputChannel)));
  // ADR-0044: the one trigger for a PUT — a landed Instance recompute, never a gesture.
  own(wireLoadOrderSyncToInstance(instance, session.loadOrderSync!));
  const revealReporter = makeReporter(outputChannel, 'pluginListTree.revealInExplorer');
  own(vscode.commands.registerCommand('modbench.pluginListTree.revealInExplorer', async (node: PluginListNode | undefined) => {
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
  }));
  return pluginListProvider;
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

// `overwrite/` is listed first so it is the QuickPick's pre-highlighted default — `showQuickPick`
// has no `activeItem` option, and array order is the only way to pre-highlight — preserving the
// xEdit-under-MO2 reflex.
async function pickPluginDestination(
  instance: Instance, instanceRoot: string,
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
    const modNames = instance.value.mods.filter((e) => e.kind === 'mod').map((e) => e.name);
    const modName = await vscode.window.showQuickPick(modNames, { placeHolder: 'Which mod?' });
    return modName ? resolvePluginDestination(instanceRoot, { kind: 'existingMod', modName }) : undefined;
  }

  const modName = await vscode.window.showInputBox({ prompt: 'New mod name' });
  if (!modName) return undefined;
  // Accepted residue: the mod folder is created before the create POST runs. If that POST
  // fails, the mod stays there — empty and disabled, same as any fresh install — rather than
  // being rolled back.
  const outcome = await createEmptyMod(instanceRoot, instance.value.activeProfile, modName);
  if (!outcome.applied) throw new Error(outcome.refusal);
  return resolvePluginDestination(instanceRoot, { kind: 'newMod', modName });
}

// ADR-0041: only once Editing's create endpoint has actually succeeded does Mod Management's
// `appendPlugin` add the load-order line — never the other way around, so the load order can
// never name a file that does not exist.
async function appendCreatedPluginToLoadOrder(
  instanceRoot: string, instance: Instance, pluginListProvider: PluginListProvider,
  pluginName: string, outputChannel: vscode.LogOutputChannel,
): Promise<void> {
  const result = await appendPlugin(instanceRoot, instance.value.activeProfile, pluginName);
  pluginListProvider.invalidate();
  if (!result.applied) {
    makeReporter(outputChannel, 'newPlugin').report(
      'error',
      `Created "${pluginName}", but could not add it to the load order — add it manually in the Plugins tree.`,
      result.refusal,
    );
    return;
  }
  void vscode.window.showInformationMessage(`Modbench: Created "${pluginName}".`);
}

function registerCreatePluginCommand(
  controller: EditingController,
  mo2: { instance: Instance; instanceRoot: string; pluginListProvider: PluginListProvider } | undefined,
  outputChannel: vscode.LogOutputChannel,
): vscode.Disposable {
  const reporter = makeReporter(outputChannel, 'newPlugin');
  return vscode.commands.registerCommand('modbench.newPlugin', async () => {
    if (!mo2) {
      reporter.report('error', 'New Plugin needs an open MO2 instance workspace.');
      return;
    }

    const name = await promptPluginName();
    if (!name) return;

    let destination: { path: string; origin: string } | undefined;
    try {
      destination = await pickPluginDestination(mo2.instance, mo2.instanceRoot);
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

    await appendCreatedPluginToLoadOrder(mo2.instanceRoot, mo2.instance, mo2.pluginListProvider, created.name, outputChannel);
  });
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


interface ReconcileDeps {
  session: ExtensionSession;
  instanceRoot: string;
  /** ADR-0044/ADR-0047: the sync reads its snapshot from this, never from a walk of its own. */
  instance: Instance;
  controller: EditingController;
  outputChannel: vscode.LogOutputChannel;
  heldPluginFiles: () => Promise<HeldPluginFiles>;
  showCrashRepairOffers: (offers: CrashRepairOffer[]) => Promise<void>;
}

// ADR-0044: the sync an Instance change and a client connect both feed. 250 ms covers a burst
// of Instance recomputes landing close together. `resolveGameDirectory`/`buildSnapshot` read one
// Instance value together (closed over below), never two generations of it.
function makeLoadOrderSync(deps: ReconcileDeps): LoadOrderSync {
  const { session, instanceRoot, instance, controller, outputChannel, heldPluginFiles, showCrashRepairOffers } = deps;
  let snapshot: ReturnType<typeof loadOrderSnapshotOf>;
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
    resolveGameDirectory: () => {
      snapshot = loadOrderSnapshotOf(instance.value);
      return Promise.resolve(snapshot ? { dataFolder: snapshot.dataFolder } : undefined);
    },
    buildSnapshot: () => Promise.resolve(snapshot?.plugins ?? []),
    makeProgressHandler: () => makeTreeProgressHandler(session),
    putLoadOrder: (plugins, dataFolder, signal, onProgress) =>
      controller.putLoadOrder(plugins, dataFolder, instanceRoot, undefined, { onProgress, signal }),
    syncFilterState: () => controller.syncFilterState(),
    applyReconciled: (failures, totalPlugins) => applyLoadOrderToTree(session, heldPluginFiles, failures, outputChannel, totalPlugins),
    presentCrashRepairOffers: (offers) => showCrashRepairOffers(offers),
  });
}

// ADR-0037: the same failures the toast inside putLoadOrder already consumed — folded in here, not
// re-derived, so one plugin's row carries one value describing every fact about it.
function withLoadFailures(
  facts: Map<string, PluginFacts>,
  failures: { name?: string | null; reason?: string | null }[],
): Map<string, PluginFacts> {
  const merged = new Map(facts);
  for (const f of failures) {
    const name = f.name ?? '?';
    merged.set(name, { ...merged.get(name), loadFailure: f.reason ?? 'Unknown error' });
  }
  return merged;
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
      `[toolbox] applying reconciled load order to tree: ${held.files.size} in the load order, ${failures.length} failed, of ${totalPlugins} copies`,
    );
    // Set before setLoadOrder fires its re-render, so no row renders off a match set stale from
    // whatever reconcile preceded this one.
    session.loadOrderSync?.setMatches(held.matches);
    session.pluginsTree?.setLoadOrder(held.files, withLoadFailures(held.facts, failures));
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
    outputChannel.error(`[toolbox] reading the backend's plugin list failed; plugin rows will not expand: ${message}`);
    void vscode.window.showWarningMessage(
      'Modbench: The load order was reconciled, but the plugin list could not be read — plugin rows will not expand into records. Close and relaunch mEdit to retry.',
    );
  }
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
      new Map(failures.map((f) => [f.name, { loadFailure: f.reason }] as const)),
    ),
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
  session: ExtensionSession, instance: Instance, outputChannel: vscode.LogOutputChannel, revealLog: () => void,
): () => Promise<void> {
  const enter = async (): Promise<void> => {
    const { abandoned } = session.loadOrderSync!.arm();
    // Overlaps with the backend starting below, same as PluginListProvider's own first-value
    // wait: `flush()` must read a real Instance value, never the empty pre-first-read sentinel.
    const instanceReady = instance.sequence > 0 ? Promise.resolve() : instance.refresh();
    revealLog(); // the launch can take a while; let the user watch the step log
    say(session, 'Starting backend…');
    outputChannel.info('[toolbox] entering editing: starting backend');
    await session.backendManager!.start();
    // Before the health gate, deliberately: a close stops the backend, so an abandoned launch
    // would otherwise fail this check and report the stop it asked for as a startup failure.
    if (abandoned()) { reportAbandoned(outputChannel); return; }
    if (!session.backendManager!.isHealthy) {
      exitEditing(session); // tear down the half-started backend and reset the view
      void vscode.window.showErrorMessage('Modbench: Backend failed to start — see the Modbench output for details.');
      return;
    }
    await instanceReady;
    // No game directory means nothing to build a snapshot from — don't strand the UI in an empty
    // editing view. `flush()` is used because this path wants the outcome, not just a promise.
    if ((await session.loadOrderSync!.flush()) === 'no-game-directory') exitEditing(session);
  };
  return () => withPluginsViewProgress(session, enter);
}

// A crash-restart is a fresh backend, so the reconcile runs again from scratch — the same re-entry
// path a fresh launch takes, not a bespoke recovery.
function wireEnterEditingOnRestart(
  session: ExtensionSession, enterEditing: () => Promise<void>, outputChannel: vscode.LogOutputChannel,
): void {
  session.backendManager!.on('restarted', () => {
    void enterEditing().catch((err: unknown) =>
      outputChannel.error(`[toolbox] reload after backend restart failed: ${err instanceof Error ? err.message : String(err)}`),
    );
  });
}


interface Mo2Side {
  instance: Instance;
  instanceRoot: string;
  modListProvider: ModListProvider;
  downloadsProvider: DownloadsProvider;
  pluginListProvider: PluginListProvider;
  refreshAll: () => Promise<void>;
  enterEditing: () => Promise<void>;
}

// Undefined on the two paths with no MO2 instance to read: no workspace folder, and a folder
// that is not one. Both leave the Toolbox view registered and row-less.
function buildMo2Side(own: Own, deps: ToolboxDeps): Mo2Side | undefined {
  const { outputChannel, session, controller, recordBrowser, heldPluginFiles, showCrashRepairOffers } = deps;
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
  const detectPaths = makeDetectPaths();
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
  // this kicks off the first real read. PluginListProvider's own `sequence === 0` guard is
  // what keeps activation from being blocking here.
  void instance.refresh();
  // ADR-0047: rows, statuses and the overwrite count all come from the Instance value now —
  // this provider builds no index and reads no disk of its own.
  const modListProvider = own(new ModListProvider({ instance, log, instanceRoot, reporter: modListReporter }));
  // ADR-0044: built before the Plugins tree, because both the tree's hasMatchingRecords accessor
  // and enterEditing below need the session slot filled first.
  session.loadOrderSync = own(makeLoadOrderSync({
    session, instanceRoot, instance, controller, outputChannel, heldPluginFiles, showCrashRepairOffers,
  }));
  // plugins.txt converges on what disk provides; the write reaches the Plugins tree and Editing's
  // Plugin load order sync through the plugins.txt watcher.
  const runPluginsReconcile = async (profile: string, folder: string | undefined) => {
    const result = await reconcilePlugins(instanceRoot, profile, folder, (msg) => outputChannel.debug(msg));
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
  const pluginListProvider = registerPluginListView({
    own, session, outputChannel, reporter: makeReporter(outputChannel, 'pluginList'), instanceRoot, dataFolder, instance, recordBrowser,
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
  const enterEditing = makeEnterEditing(session, instance, outputChannel, () => outputChannel.show(true));
  wireEnterEditingOnRestart(session, enterEditing, outputChannel);
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
    rebuildIndex: () => controller.rebuildIndex(
      instanceRoot,
      (message, detail) => makeReporter(outputChannel, 'refresh').report('error', message, detail),
    ),
    sendLoadOrder: () => session.loadOrderSync!.flush(),
    // The Mods tree renders the Instance's value now (ADR-0047): force a real re-read of disk,
    // not just a re-render of whatever the Instance last landed.
    invalidateMods: () => { void instance.refresh(); modListProvider.invalidate(); },
    // Same as invalidateMods above: Plugins renders the Instance value too (ADR-0047).
    invalidatePlugins: () => { void instance.refresh(); pluginListProvider.invalidate(); },
    // Same as invalidatePlugins above: Downloads renders the Instance value too (ADR-0047).
    invalidateDownloads: () => { void instance.refresh(); downloadsProvider.invalidate(); },
    updateProfileDescription,
  });
  return { instance, instanceRoot, modListProvider, downloadsProvider, pluginListProvider, refreshAll, enterEditing };
}

const ownAll = (own: Own, disposables: vscode.Disposable[]): void => {
  for (const disposable of disposables) own(disposable);
};

export function createToolbox(deps: ToolboxDeps): Toolbox {
  const { outputChannel, session, controller, loadDiagnostics, getDiagnoses } = deps;
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
    isStandaloneDeployment,
  });
  own(vscode.window.createTreeView('modbench.toolbox', { treeDataProvider: provider }));
  if (mo2) own(mo2.instance.subscribe(() => provider.refresh()));
  // The deployment row appears and disappears with the mode, which is a setting rather than
  // anything the Instance watches.
  own(registerDeploymentModeContext(() => provider.refresh()));
  // Its scope is the workspace, so it lives here rather than on any single tree — and it is only
  // the safety net for a flaky watcher, never the primary path.
  own(vscode.commands.registerCommand('modbench.refresh', async () => {
    await mo2?.refreshAll();
    provider.refresh();
  }));
  own(registerCreatePluginCommand(controller, mo2, outputChannel));

  // ADR-0026 background tier — the scan is advisory, so a blip logs and retries next reconcile,
  // never toasts. Fire-and-forget: the tree hand-off must not wait on a whole-load-order scan.
  let diagnosisScanGeneration = 0;
  session.refreshDiagnoses = () => {
    // No instance root means no MO2 workspace — nothing a diagnosis could point at.
    if (!mo2) return;
    // Generation guard: a slow scan answering after a newer reconcile's own refresh (or after
    // teardown cleared everything) must not resurrect a stale answer.
    const generation = ++diagnosisScanGeneration;
    void getDiagnoses().then((reports) => {
      if (generation !== diagnosisScanGeneration) return;
      publishLoadDiagnoses(loadDiagnostics, mo2.instanceRoot, reports);
      session.pluginsTree?.setDiagnoses(groupDiagnosesByPlugin(reports));
    }).catch((err: unknown) => {
      outputChannel.warn(`[toolbox] the malformed-plugin scan could not be read: ${err instanceof Error ? err.message : String(err)}`);
    });
  };

  return {
    modListProvider: mo2?.modListProvider,
    downloadsProvider: mo2?.downloadsProvider,
    pluginListProvider: mo2?.pluginListProvider,
    instance: mo2?.instance,
    enterEditing: mo2?.enterEditing,
    dispose: () => {
      for (const disposable of owned.reverse()) disposable.dispose();
      owned.length = 0;
    },
  };
}

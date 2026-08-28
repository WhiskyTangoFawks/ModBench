import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as cp from 'child_process';
import { Agent, fetch as undiciFetch } from 'undici';
import { BackendManager } from './medit/BackendManager';
import { backendLogLevelArgs, makeBackendLogForwarder } from './medit/backendLog';
import { createApiClient, type ApiClient, type MasterIssue, type CompileResult, type CrashRepairOffer } from './medit/ApiClient';
import { presentCrashRepairOffers } from './medit/crashRepairOffer';
import { detectGamePaths, detectWinePrefix } from './medit/GamePathDetector';
import { SessionController, type SessionLoadProgress } from './medit/SessionController';
import { makeLoadProgressHandler } from './medit/sessionProgress';
import {
  InteriorLoadMoreNode, PluginTreeNode, PluginTreeProvider, RecordTypeNode, RecordNode, PlacedNode, headerFormKeyFor,
  StackPeerNode, StackBinaryStateNode,
} from './medit/PluginTreeProvider';
import {
  ReferencedByTreeProvider, ReferencedByGroupNode, referencedByCopyText, type ReferencedByTreeNode,
} from './medit/ReferencedByTreeProvider';
import { ActiveRecordTracker } from './medit/ActiveRecordTracker';
import { resolveCompileTarget, type CompileTarget } from './medit/compileTarget';
import { ApiPluginRepository, type PluginRepository } from './medit/PluginRepository';
import { trackedModFoldersOf, registerTrackedRepositories, isTracked } from './medit/trackedRepositories';
import { startExternalChangePolling, runRebase, gateExternalChangePolling, type OpenMergeEditor } from './medit/externalChangeCoordinator';
import { trackProgressMessage } from './medit/trackProgress';
import { FilterCodeLensProvider } from './medit/FilterCodeLensProvider';
import { buildWebviewHtml } from './medit/webviewHtml';
import {
  EXTENSION_TO_WEBVIEW, type ExtensionToWebview, type ArrayElementContext, type ArrayParentContext,
  type VmadScriptsContext, type VmadScriptContext, type VmadPropertyContext, type ColumnHeaderContext,
  type StringValueContext,
} from './medit/messages';
import { copyTargetPlugins, type CopyGesture } from './medit/copyTargetPlugins';
import { routeRecordPanelMessage, pickScriptNameViaInputBox, type RouteRecordPanelMessageDeps } from './medit/recordPanelMessageRouter';
import { RecordDecorationProvider } from './medit/RecordDecorationProvider';
import { recordResourceUri } from './medit/recordResourceUri';
import { Mo2ModlistSource } from './modmanager/mo2/Mo2ModlistSource';
import { isMo2Instance } from './modmanager/detectMo2Instance';
import { ModListProvider, ModNode, OverwriteNode, SeparatorNode, type ModlistNode } from './modmanager/ModListProvider';
import { createOverwriteWatcher } from './modmanager/overwriteWatcher';
import { createModsWatcher } from './modmanager/modsWatcher';
import { createModlistWatcher } from './modmanager/modlistWatcher';
import { OverwriteDecorationProvider } from './modmanager/OverwriteDecorationProvider';
import {
  PluginListProvider, pluginFileOf, orderIssueMastersOf, pluginNamesInSelection, type PluginListNode,
} from './modmanager/PluginListProvider';
import { buildSelectedPluginsFilterSql } from './medit/filterSelectedPluginsSql';
import { PluginsTreeComposite } from './PluginsTreeComposite';
import { createDriftTracker, type DriftTracker } from './pluginDrift';
import type { GameDirectory, DetectPaths } from './modmanager/gameDirectory';
import { createGameDirectoryResolver, dataFolderFrom, type GameDirectoryResolver } from './modmanager/gameDirectoryResolver';
import { deploy, isDeployed, purge, type LoadOrderDeployment, type Reporter } from './modmanager/deployer';
import { buildFileConflictIndex } from './modmanager/fileConflictIndex';
import { buildExplicitPluginsWithOrigin, resolveCurrentPluginOrigins } from './modmanager/explicitSession';
import { resolvePluginDestination, type PluginDestinationChoice } from './modmanager/pluginDestination';
import { detectRoot } from './modmanager/install/detectRoot';
import { extractArchive } from './modmanager/install/extractArchive';
import {
  registerDownloadsHiddenToggleCommands,
  registerDownloadsMultiRowCommands,
  registerDownloadsSingleRowCommands,
  registerDownloadsSortCommand,
} from './modmanager/DownloadsPanel';
import { DownloadsProvider } from './modmanager/DownloadsProvider';
import { createDownloadsWatcher } from './modmanager/downloadsWatcher';
import { HiddenDownloadDecorationProvider } from './modmanager/HiddenDownloadDecorationProvider';
import { ImplicitMasterDecorationProvider } from './modmanager/ImplicitMasterDecorationProvider';
import { FileOverrideDecorationProvider } from './modmanager/FileOverrideDecorationProvider';
import { makeReporter } from './reporter';
import { LoadoutHeaderProvider } from './LoadoutHeaderProvider';
import { registerNameFilter, type NameFilter } from './nameFilter';

let backendManager: BackendManager | undefined;
// #247: the Loadout header re-reads its rows whenever workspace-scope state moves. Module
// level for the same reason pluginsTree below is — the choke points that move that state
// (exitToLoadout, switchProfile) are module-level functions too.
let loadoutHeaderProvider: LoadoutHeaderProvider | undefined;
// #270: the merged Plugins tree. Module level for the same reason as the above — the session
// starting and stopping is what puts chevrons on its rows, and both choke points for that
// (enterEditing, exitToLoadout) are module-level.
let pluginsTree: PluginsTreeComposite<PluginListNode, PluginTreeNode> | undefined;
// #279: module-level for the same reason pluginsTree is — the session lifecycle (enter,
// close, backend death) hands it state from call sites that never see the view's wiring.
let driftTracker: DriftTracker | undefined;
// #307: the same view, as a TreeView — what carries the load's own progress (a native header
// progress indicator, addressed by this view id) and its incompleteness statement
// (`TreeView.message`). Module level for the same reason as pluginsTree above: enterEditing and
// exitToLoadout are module-level, and both have to be able to set and clear it.
let pluginsTreeView: vscode.TreeView<PluginListNode | PluginTreeNode> | undefined;
// #255: the same view's name filter. Module level for the same reason as the two above — the
// record filter (a second, independent narrowing axis) has to be able to add itself to this
// view's readout from `activate`'s own setFilterActive, which runs before the view exists.
let pluginsNameFilter: NameFilter | undefined;
// #307 AC7: the in-flight load's abort handle. Module level for the same reason as the above —
// exitToLoadout is where a load gets deliberately abandoned, and it is module-level. Replaced by
// each new load; a superseded one does not need aborting, since the backend answers it 409.
let loadAbort: AbortController | undefined;
// #278 / ADR-0035 amending ADR-0018: per-plugin filter matches, lowercased filename → does this
// plugin own at least one record the active record filter matches. Module level for the same
// reason as pluginsTree above — SessionController's setFilter/clearFilter are the choke points
// that invalidate it (via refreshMatchingPlugins below), and they run before the composite that
// reads it exists. `undefined` (never fetched, or no filter active) reads as "matches" everywhere
// it's consulted — the same safe default PluginsTreeComposite.hasMatchingRecords itself falls
// back to when the accessor has nothing to say.
let matchingPlugins: Map<string, boolean> | undefined;

/** #307: the Plugins view's own statement about what it is doing, or what it does not yet know
 *  (`TreeView.message` — the native surface for a view-scoped statement about its own contents,
 *  so there is no banner row and no bespoke widget). `undefined` clears it, which is the value
 *  the property itself takes. */
function say(message: string | undefined): void {
  if (!pluginsTreeView) return;
  pluginsTreeView.message = message;
  // #255: one message surface, two things that can want it. The load's statement wins while it
  // has something to say; when it stops, whatever the name filter had to say comes back — a
  // no-matches statement must not be silently swallowed by a load that has since finished.
  if (message === undefined) pluginsNameFilter?.refresh();
}

/** #307 / ADR-0035 AC2: run `work` with a progress indicator in the **Plugins view's own header**,
 *  addressed by view id. One indicator, in the view whose contents are being loaded, running for
 *  the whole operation — the backend spawn, the indexing, and the winner sweep, which the load
 *  POST only returns after.
 *
 *  It used to be a `ProgressLocation.Notification` wrapped around the load at two command sites;
 *  two indicators for one operation is noise, and the third caller (the crash-restart reload) had
 *  no indicator at all. The header bar carries no text, so the step messages go to `say` above —
 *  one surface, one voice.
 *
 *  AC5: the message clears here, on every exit path including `work`'s own early returns and
 *  throws, so no failure can leave the view claiming a load that is not running.
 *
 *  Deliberately not `cancellable`: the header location has no cancel affordance (that is a
 *  Notification-only option), and abandoning a load is Close mEdit's job, not a second control. */
function withPluginsViewProgress(work: () => Promise<void>): Promise<void> {
  return Promise.resolve(vscode.window.withProgress(
    { location: { viewId: 'modbench.pluginListTree' } },
    async () => { try { await work(); } finally { say(undefined); } },
  ));
}
// #281: the record browser behind the merged tree's children. Module level for the same reason as
// pluginsTree directly above — the session starting/stopping is what tells its record rows which
// plugins are immutable (Remove hidden via contextValue), through the same choke points.
let recordBrowserProvider: PluginTreeProvider | undefined;
// #295: `enterEditing` itself, built once inside `registerLoadoutView`. Module level for the
// same reason as the above — not a registration-order race (registerLoadoutSurfaces, which
// calls registerLoadoutView, already runs before registerEditorCommands registers
// modbench.reloadSession), but because registerLoadoutView returns *before* ever building this
// closure when there is no workspace, or the workspace isn't an MO2 instance (see that
// function's own early returns), leaving it permanently unset for the lifetime of that
// activation. Assigned exactly once, where `enterEditing` is built; every reader treats it as
// possibly-absent for that reason, not as a race to guard against.
let enterEditingFn: (() => Promise<void>) | undefined;
// #354: module level for the same reason as the above — exitToLoadout has to reach the record
// filter's single writer (the context key its Clear action is gated on, the code lens's active
// SQL, and the readout) to end the filter's UI state on session close, and a local `const` inside
// activate() is structurally unreachable from there. Assigned exactly once, alongside where
// makeSetFilterActive builds it.
let setFilterActive: ReturnType<typeof makeSetFilterActive> | undefined;

const meditConfig = () => vscode.workspace.getConfiguration('modbench');

/** #192: stub provider for the Mods view when the workspace isn't an MO2
 *  instance. Always empty so VS Code's `viewsWelcome` contribution (gated on
 *  `modbench.workspaceIsMo2Instance`) renders instead of the tree — getTreeItem
 *  is unreachable since getChildren never yields an element to render. */
const NOT_MO2_INSTANCE_PROVIDER: vscode.TreeDataProvider<never> = {
  getTreeItem: () => { throw new Error('unreachable — NOT_MO2_INSTANCE_PROVIDER never yields children'); },
  getChildren: () => [],
};

/** #270 / #276 / #277: which plugin files the running session actually holds — the session's own
 *  list, not the one we sent it, because the backend prepends the game's implicit masters and
 *  those are rows in the Plugins tree too — plus, of that set, which are read-only for editing
 *  (Editing's "Immutable plugin", `PluginMetadata.isImmutable`) and each plugin's own master
 *  issues (`PluginMetadata.masterIssues`, #277 / ADR-0037). Bundled as one fact, not three
 *  separate reads: all three come off the same `getPlugins()` call and are handed to
 *  `PluginsTreeComposite.setSession` together, so there is never a moment where a caller could
 *  have one without the others. */
interface SessionPluginFiles {
  files: Set<string>;
  readOnly: Set<string>;
  masterIssues: Map<string, MasterIssue[]>;
  /** #279: the origin each held plugin was actually read from — half of the drift comparison, the
   *  other half being what Mod Management says the name resolves to now. Carried in the same
   *  hand-off as everything else the session reports about its plugins, for the same reason. */
  origins: Map<string, string>;
  /** #278 / ADR-0035 amending ADR-0018: lowercased filename → does this plugin own at least one
   *  record the *current* record filter matches. Carried in the same hand-off, for the same
   *  reason as `origins` — this call already asked `GET /plugins` the question, and every session
   *  (re)load reaches it downstream of `SessionController.syncFilterState()`
   *  (`makeEnterEditing`'s `enter()`, shared by Launch mEdit, the crash-restart handler and
   *  `modbench.reloadSession` alike), so this is the one hand-off through which the filter state
   *  a fresh or reloaded session actually has — not the one an in-session `setFilter`/`clearFilter`
   *  last left behind — reaches `matchingPlugins`. That is what keeps the map from outliving a
   *  session it no longer describes. */
  matches: Map<string, boolean>;
  /** #448: every plugin whose own physical folder is tracked (`isTracked`, `trackedRepositories.ts`
   *  — `.git` present) — the Stack node's own state-entry gate (CONTEXT.md: "Editing requires
   *  tracking; viewing never does"). Computed the same fs check `trackedModFoldersOf` already
   *  performs per distinct folder, just keyed back to the plugin name here instead. */
  trackedPlugins: Set<string>;
}

function sessionPluginFilesFrom(repository: ApiPluginRepository): () => Promise<SessionPluginFiles> {
  return async () => {
    const plugins = await repository.getPlugins();
    return {
      files: new Set(plugins.map((p) => p.name)),
      readOnly: new Set(plugins.filter((p) => p.isImmutable).map((p) => p.name)),
      // #277 / ADR-0037: the wire's `masterIssues` is optional/nullable even though the backend
      // always emits an array — `PluginRepository.toPluginMetadata()` already normalizes this,
      // but `?? []` here too rather than trusting that guarantee silently, per the field's own
      // wire contract (`masterIssues?: MasterIssue[] | null`).
      masterIssues: new Map(plugins.map((p) => [p.name, p.masterIssues ?? []] as const)),
      origins: new Map(plugins.map((p) => [p.name, p.origin] as const)),
      matches: new Map(plugins.map((p) => [p.name.toLowerCase(), p.hasMatchingRecords] as const)),
      trackedPlugins: new Set(plugins.filter((p) => isTracked(path.dirname(p.path))).map((p) => p.name)),
    };
  };
}

/** #278 / ADR-0035 amending ADR-0018: `SessionController.setFilter`/`clearFilter`'s
 *  `refreshMatchingPlugins` — re-derives `matchingPlugins` off a fresh `GET /plugins` and
 *  re-renders, so `PluginsTreeComposite`'s chevron reads the filter that is active now, not the
 *  one that produced the last set. The *other* path that can change which filter is active —
 *  a session (re)load, which can start already-filtered or unfiltered — does not come through
 *  here; it is covered by `applyLoadedSessionToTree` reusing this same `GET /plugins` answer via
 *  `SessionPluginFiles.matches` below, not by a second call site into this function. A read
 *  failure here degrades to "no data" (matches everywhere) rather than throwing — a chevron guess
 *  is wrong in the same direction `hasMatchingRecords` already treats as safe, and a record
 *  filter's whole *point* is to be applied and inspected, so silently freezing every chevron would
 *  be a far worse failure than briefly over-showing them. */
async function refreshMatchingPlugins(repository: ApiPluginRepository, outputChannel: vscode.LogOutputChannel): Promise<void> {
  try {
    const plugins = await repository.getPlugins();
    matchingPlugins = new Map(plugins.map((p) => [p.name.toLowerCase(), p.hasMatchingRecords] as const));
  } catch (err) {
    outputChannel.error(`[extension] refreshing the record filter's plugin matches failed: ${err instanceof Error ? err.message : String(err)}`);
    matchingPlugins = undefined;
  }
  pluginsTree?.refreshDecorations();
}

/** The one shape this extension needs from `vscode.git`'s exported API (ADR-0041: "the native git
 *  UI is the review surface") — deliberately not the full upstream `git.d.ts`, just the two members
 *  actually called, so there is nothing here to drift out of sync with an API surface this
 *  extension otherwise never touches. */
interface MinimalGitApi {
  openRepository(uri: vscode.Uri): Thenable<unknown>;
}
interface GitExtensionExports {
  getAPI(version: 1): MinimalGitApi;
}

/** #414/ADR-0041: one `openRepository` per distinct tracked mod folder, so each shows its own
 *  native Source Control group — re-run whenever the session becomes newly readable
 *  (`notifyConflictsComputed`'s own call site) and immediately after a successful Track, so a
 *  freshly tracked repo appears without waiting for the next activation. Silent no-op (logged, not
 *  surfaced) when `vscode.git` isn't installed/enabled: this only ever narrows the native UI this
 *  ticket adds, never blocks reading or editing. */
async function registerTrackedRepositoriesForSession(repository: ApiPluginRepository, outputChannel: vscode.LogOutputChannel): Promise<void> {
  try {
    const gitExtension = vscode.extensions.getExtension<GitExtensionExports>('vscode.git');
    if (!gitExtension) {
      outputChannel.warn('[extension] vscode.git extension not found — tracked mods will not appear in Source Control');
      return;
    }
    const exports = gitExtension.isActive ? gitExtension.exports : await gitExtension.activate();
    const gitApi = exports.getAPI(1);

    const plugins = await repository.getPlugins();
    const folders = trackedModFoldersOf(plugins);
    await registerTrackedRepositories((folder) => Promise.resolve(gitApi.openRepository(vscode.Uri.file(folder))), folders);
  } catch (err) {
    outputChannel.error(`[extension] registering tracked repositories with vscode.git failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Leave editing: tear down the editing backend. #273: there is no separate loadout view mode
 *  to switch back to any more — the loadout views were never hidden (#268), and Referenced By
 *  governs its own visibility. */
function exitToLoadout(): void {
  // #307 AC7: abandon any load still in flight *first* — it aborts the POST outright, so the
  // load stops polling and returns 'abandoned' rather than discovering a killed backend as a
  // network error and reporting that to the user as a failure.
  loadAbort?.abort();
  loadAbort = undefined;
  // #270: the chevrons go with the session. Cleared before the backend stops, so no row can be
  // expanded into a backend that is on its way down. #281: the immutable set goes with it.
  pluginsTree?.setSession(undefined);
  // #279: and so does drift — it is a statement about the plugins *this* session read, so it
  // cannot outlive it. Cleared directly rather than recomputed, for the same reason as the
  // decorations below: with no session there is nothing to compare against, so the
  // answer is known without asking.
  driftTracker?.setLoaded(undefined);
  // #307: so does anything the load was saying about itself. A statement about a session that no
  // longer exists is the same class of silent-wrong-state as a stale chevron.
  say(undefined);
  // #255 / #354: and so does the record filter's whole UI state — the Clear action's context key,
  // the code lens's active SQL, and the Plugins tree readout's record-filter half — all through
  // the same single writer every other record-filter change goes through, so `modbench.filterActive`
  // stays written from exactly one place. (The name filter's half of the readout is untouched: it
  // filters load-order rows, which are still there.)
  setFilterActive?.(false);
  // #278 / ADR-0035 amending ADR-0018: and so does the match set it drove — a statement about
  // which plugins *this* session's records matched, same reasoning as drift just above.
  matchingPlugins = undefined;
  recordBrowserProvider?.setImmutablePlugins([]);
  // #448: no session means nothing is tracked or origin-known any more either — the Stack node's
  // own state entries clear along with everything else this reset already clears.
  recordBrowserProvider?.setTrackedPlugins([]);
  recordBrowserProvider?.setPluginOrigins(new Map());
  // #364: no session means no conflict information either — the Conflicts node and the badge both
  // have to disappear along with everything else this reset already clears, not linger describing
  // a session that's gone.
  recordBrowserProvider?.setConflictsComputed(false);
  backendManager?.stop();
}

/** Everything that follows the record filter turning on or off: the context key its Clear
 *  action is gated on, the code lens's notion of which SQL is live, and (#255) the Plugins
 *  tree's readout — where the record filter is one of two independent narrowing axes and is
 *  named by its *source*, never by its SQL, because a `WHERE` clause is not a readout. `SQL` is
 *  the honest fallback for a filter read back off the backend at session start, whose source
 *  this frontend never saw.
 *
 *  The single writer for all three, called with `false` and nothing else by #354's exitToLoadout
 *  to end the record filter's UI state on session close, the same way SessionController's own
 *  setFilter/clearFilter/syncFilterState call it in session. `modbench.filterActive` is written
 *  from exactly this one place. */
function makeSetFilterActive(filterProvider: FilterCodeLensProvider) {
  return (active: boolean, sql?: string, label?: string) => {
    void vscode.commands.executeCommand('setContext', 'modbench.filterActive', active);
    filterProvider.setActiveSql(active ? (sql ?? null) : null);
    pluginsNameFilter?.setBaseDescription(active ? `records: ${label ?? 'SQL'}` : undefined);
  };
}

/** Game-path resolver: explicit `game.*` overrides if both set, else autodetect.
 *  Shared by the session wizard, the deploy commands, and editing launch. */
function makeDetectPaths(): DetectPaths {
  return () => {
    const c = meditConfig();
    const dataOverride = (c.get('game.dataFolderPath') as string) ?? '';
    const pluginsOverride = (c.get('game.pluginsTxtPath') as string) ?? '';
    if (dataOverride && pluginsOverride) {
      return Promise.resolve({ dataFolder: dataOverride, pluginsTxt: pluginsOverride });
    }
    return detectGamePaths(process.platform);
  };
}

// Issue #282: the "Referenced By" tree — provider + view construction pulled out of `activate`
// (which is already at its line budget) purely to keep that one under the lint budget; no other
// reason to split it out. Lives in the Panel container now (package.json) and retargets on
// `activeRecordTracker`'s active-record changes instead of an explicit command — `showFor` is
// wired here, once, rather than at every command call site. The onCountChanged callback below
// closes over `referencedByTreeView` before its own `const` line runs — safe because VS Code
// never calls getChildren (and so never invokes the callback) until createTreeView returns and
// this whole function has finished, by which point the const is long since initialized.
function createReferencedByTree(
  client: ApiClient, log: (msg: string) => void, activeRecordTracker: ActiveRecordTracker<vscode.WebviewPanel>,
) {
  const referencedByTreeProvider = new ReferencedByTreeProvider(client, log, (count) => {
    // #273 Slice B: the declared name is "Plugins - Referenced By" — its own sub-functionality
    // naming convention (ADR-0035) — and the runtime count badge carries the same prefix so the
    // title never reverts to the pre-rename text once a count is known.
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
  return { referencedByTreeProvider, referencedByTreeView, activeRecordSubscription };
}

/** `SessionController`'s own `notifyConflictsComputed` dep — pulled out of `activate` (#364,
 *  which pushed that function over the lint line budget) purely to stay under it, same shape as
 *  `makeSetFilterActive` above. Fires on the load-completing false→true `conflictsComputed`
 *  transition only (this dep's own doc comment): tells every open record panel to refetch its
 *  comparison, (re-)registers every tracked mod's repo with `vscode.git`, and (#364) flips the
 *  Conflicts node/badge gate on `treeProvider`. */
function makeNotifyConflictsComputed(
  treeProvider: PluginTreeProvider, recordPanels: Set<vscode.WebviewPanel>,
  repository: ApiPluginRepository, outputChannel: vscode.LogOutputChannel,
): () => void {
  return () => {
    broadcastToRecordPanels(recordPanels, { type: EXTENSION_TO_WEBVIEW.SESSION_CONFLICTS_COMPUTED });
    // #414/ADR-0041: the session just became newly readable — the one reliable point (see this
    // dep's own doc comment) to (re-)register every tracked mod's repo with vscode.git.
    void registerTrackedRepositoriesForSession(repository, outputChannel);
    // #364: the Conflicts node's own gate and the badge's own gate — same fact, same call site as
    // the two above, and the same documented forward-coupling gap (SessionController's own comment
    // on this dep): a live-mutation re-sweep (#97) does not yet call this again on the way *out* of
    // settled, so a stale true can outlive a reorder/enable/disable until #97 wires that
    // notification too. Not a regression this ticket introduces — the message-based consumers
    // (`sessionProgress.ts`) already inherit the identical gap.
    treeProvider.setConflictsComputed(true);
  };
}

export function activate(context: vscode.ExtensionContext) {
  const cfg = vscode.workspace.getConfiguration('modbench');
  const port: number = cfg.get('backendPort') ?? 5172;

  const outputChannel = vscode.window.createOutputChannel('Modbench', { log: true });
  context.subscriptions.push(outputChannel);
  // #198: `log` is now a compat shim (defaults to .info) for modules taking a flat `(msg) => void`.
  const log = (msg: string) => outputChannel.info(msg);

  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  context.subscriptions.push(statusBarItem);
  // #416: Save & Compile's diagnostics — one collection for every tracked mod's source files, kept
  // current per compile (publishCompileDiagnostics replaces a mod's own entries wholesale each run).
  const compileDiagnostics = vscode.languages.createDiagnosticCollection('modbench-compile');
  context.subscriptions.push(compileDiagnostics);
  backendManager = createBackendManager(port, outputChannel, statusBarItem);
  wireSessionRunningContext(backendManager);

  const client = createApiClient(port, createUnlimitedFetch());
  const repository = new ApiPluginRepository(client, log);
  const treeProvider = new PluginTreeProvider(repository, log);
  recordBrowserProvider = treeProvider;
  const openPanels = new Map<string, vscode.WebviewPanel>();
  const recordPanels = new Set<vscode.WebviewPanel>();
  // #282: the Referenced By view's input — which record panel is active and what FormKey it
  // shows — replacing the old showReferencedBy(node) command argument.
  const activeRecordTracker = new ActiveRecordTracker<vscode.WebviewPanel>();
  const { scriptsPath, filterProvider } = setupScripts(cfg);

  setFilterActive = makeSetFilterActive(filterProvider);

  const controller = new SessionController({
    client,
    repository,
    log,
    refreshTree: () => treeProvider.refresh(),
    setStatusText: (t) => { statusBarItem.text = t; },
    showWarning: (msg) => { void vscode.window.showWarningMessage(msg); },
    showError: (msg) => { void vscode.window.showErrorMessage(msg); },
    setFilterActive,
    refreshMatchingPlugins: () => { void refreshMatchingPlugins(repository, outputChannel); },
    notifyConflictsComputed: makeNotifyConflictsComputed(treeProvider, recordPanels, repository, outputChannel),
  });
  const { referencedByTreeView, activeRecordSubscription } = createReferencedByTree(client, log, activeRecordTracker);
  const showCrashRepairOffers = makeCrashRepairOffersPresenter(controller, compileDiagnostics);
  const { modListProvider, downloadsProvider, pluginListProvider, modlistSource, instanceRoot } = registerLoadoutSurfaces({ context, log, outputChannel, controller, recordBrowser: treeProvider, sessionPluginFiles: sessionPluginFilesFrom(repository), showCrashRepairOffers });

  wireExternalChangePolling(repository, controller, outputChannel, log);

  context.subscriptions.push(
    referencedByTreeView,
    activeRecordSubscription,
    vscode.languages.registerCodeLensProvider({ language: 'sql' }, filterProvider),
    ...registerPluginRowCommands(controller, repository, activeRecordTracker, outputChannel, compileDiagnostics),
    registerCreatePluginCommand(controller, modlistSource, instanceRoot, pluginListProvider, outputChannel),
    ...registerEditorCommands({
      context, openPanels, recordPanels, activeRecordTracker, port, treeProvider, controller, repository, scriptsPath, referencedByTreeView, log, outputChannel,
    }),
  );

  // The backend is now spawned lazily on entering editing (Launch mEdit) and
  // torn down on Close mEdit — the extension owns its lifecycle (ADR-0022). There
  // is no auto-connect / auto-wizard at activation; show a neutral idle state.
  statusBarItem.text = '$(plug) mEdit';

  // Exposed for integration tests (pinned Overwrite row #82; editing tree after launch #75;
  // leveled output channel #198; Downloads tree #233; merged Plugins tree #270; #273/#331
  // toggle both ways) — unused in production. #273: treeView (the old modbench.pluginTree's own
  // TreeView) is gone along with that view — treeProvider itself stays, since it still supplies
  // the merged tree's children.
  return {
    modListProvider, downloadsProvider, pluginListProvider, pluginsTree, pluginListView: pluginsTreeView, treeProvider,
    outputChannel,
  };
}


interface EditorCommandDeps {
  context: vscode.ExtensionContext;
  openPanels: Map<string, vscode.WebviewPanel>;
  // Every open 'modbench'-viewType record panel — see openRecordPanel's recordPanels param.
  recordPanels: Set<vscode.WebviewPanel>;
  // #282: which of recordPanels is active, and what FormKey each shows — openRecordPanel keeps
  // this current; the Referenced By view retargets from it, not from a command argument.
  activeRecordTracker: ActiveRecordTracker<vscode.WebviewPanel>;
  port: number;
  treeProvider: PluginTreeProvider;
  controller: SessionController;
  repository: ApiPluginRepository;
  scriptsPath: string;
  // Issue #282: the Referenced By view itself — needed for its Copy command's selection
  // fallback (`.selection`). The provider is
  // no longer threaded here: nothing in this file retargets it directly anymore (createReferencedByTree
  // wires that to activeRecordTracker once, in `activate`).
  referencedByTreeView: vscode.TreeView<ReferencedByTreeNode>;
  log: (msg: string) => void;
  outputChannel: vscode.LogOutputChannel;
}

/** Editor-side commands, grouped so no single registrar exceeds the size budget. */
function registerEditorCommands(deps: EditorCommandDeps): vscode.Disposable[] {
  return [
    ...registerRecordViewCommands(deps),
    ...registerArrayOpCommands(deps.recordPanels),
    ...registerVmadOpCommands(deps.recordPanels),
    ...registerFieldOpCommands(deps.recordPanels),
  ];
}

// #258 / ADR-0039: the string cell's right-click menu — same broadcast-and-self-filter shape as
// registerArrayOpCommands/registerVmadOpCommands above and for the identical reason (the
// extension host has no live reference into any open panel's own React state, which alone holds
// the record's current display label). Unlike those two, there's nothing to compute here beyond
// forwarding `ctx` — `stringValueContext` (recordUtils.ts) already carries the cell's own current
// value and readOnly flag, computed webview-side at right-click time, so the matching panel's own
// listener can call `handleOpenExtended` directly with no further webview-side computation
// (RecordPanel.tsx's FIELD_OPEN_EXTENDED_EDITOR branch).
function registerFieldOpCommands(recordPanels: Set<vscode.WebviewPanel>): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('modbench.field.openExtended', (ctx?: StringValueContext) => {
      if (!ctx) return;
      broadcastToRecordPanels(recordPanels, {
        type: EXTENSION_TO_WEBVIEW.FIELD_OPEN_EXTENDED_EDITOR,
        formKey: ctx.formKey, plugin: ctx.plugin, origin: ctx.origin, fieldName: ctx.fieldName,
        value: ctx.value, readOnly: ctx.readOnly, path: ctx.path, rootField: ctx.rootField,
      });
    }),
  ];
}

// Issue #142/#227 (#426 Track 4: restored): the array-op right-click commands — the extension
// host has no live reference into any open panel's own React state (which alone holds the
// record's current values), so each command only resolves *which* row/column was clicked (from
// the `data-vscode-context` VS Code parses and hands it as `ctx`) and broadcasts; every open
// panel self-filters on `formKey` and, if it matches, writes the array through the exact same
// computation (recordUtils.ts's moveArrayElement/removeArrayElement/appendArrayElement, then
// EDIT_FIELD) the keyboard accelerators (Insert/Delete/Ctrl+↑/Ctrl+↓, pure in-webview) already use.
function registerArrayOpCommands(recordPanels: Set<vscode.WebviewPanel>): vscode.Disposable[] {
  return [
    // #535: forwards ctx.rootField/ctx.path verbatim (renamed from fieldName/index) — see
    // ArrayParentContext/ArrayElementContext's own doc comments (medit/messages.ts).
    vscode.commands.registerCommand('modbench.array.add', (ctx?: ArrayParentContext) => {
      if (!ctx) return;
      broadcastToRecordPanels(recordPanels, {
        type: EXTENSION_TO_WEBVIEW.ARRAY_ADD, formKey: ctx.formKey, plugin: ctx.plugin, origin: ctx.origin, rootField: ctx.rootField, path: ctx.path,
      });
    }),
    vscode.commands.registerCommand('modbench.array.remove', (ctx?: ArrayElementContext) => {
      if (!ctx) return;
      broadcastToRecordPanels(recordPanels, {
        type: EXTENSION_TO_WEBVIEW.ARRAY_REMOVE, formKey: ctx.formKey, plugin: ctx.plugin, origin: ctx.origin, rootField: ctx.rootField, path: ctx.path,
      });
    }),
    vscode.commands.registerCommand('modbench.array.moveUp', (ctx?: ArrayElementContext) => {
      if (!ctx) return;
      broadcastToRecordPanels(recordPanels, {
        type: EXTENSION_TO_WEBVIEW.ARRAY_MOVE_UP, formKey: ctx.formKey, plugin: ctx.plugin, origin: ctx.origin, rootField: ctx.rootField, path: ctx.path,
      });
    }),
    vscode.commands.registerCommand('modbench.array.moveDown', (ctx?: ArrayElementContext) => {
      if (!ctx) return;
      broadcastToRecordPanels(recordPanels, {
        type: EXTENSION_TO_WEBVIEW.ARRAY_MOVE_DOWN, formKey: ctx.formKey, plugin: ctx.plugin, origin: ctx.origin, rootField: ctx.rootField, path: ctx.path,
      });
    }),
  ];
}

// Issue #231 (review): Set Script Flags/Set Property Flags' own QuickPick choices — VMAD's fixed,
// stable flag vocabulary (the binary format's own enum, VmadCodec.cs's ScriptEntry.Flag/
// ScriptProperty.Flag). Mirrored here rather than imported from webview/src/vmadOps.ts across the
// webview/extension-host process boundary (nothing else on this side needs that module).
const VMAD_SCRIPT_FLAGS = ['Local', 'Inherited', 'Removed', 'InheritedAndRemoved'] as const;
const VMAD_PROP_FLAGS = ['Edited', 'Removed'] as const;

// Issue #231 (#426 Track 5: restored, simplified): VMAD's own structural-op commands — same
// broadcast-and-self-filter shape as registerArrayOpCommands above, reached from the "Scripts
// (VMAD)" wrapper row (Add Script), a script row (Remove Script, Add Property, Set Script Flags),
// or a property row (Remove Property, Set Property Flags). Unlike the historical (pre-#410)
// six-message design, every op below (other than Add Script's own name prompt and Add Property's
// dialog-open signal) collapses to one VMAD_STRUCTURAL_OP broadcast carrying a VmadPath fieldPath
// and an op-envelope value — RecordFieldWriter.ApplyVmadField's own contract (Track 0), the same
// door EDIT_FIELD already opens. Add Script still needs its own native input box
// (pickScriptNameViaInputBox — no round trip through the webview, unlike the pre-#231 bridge) since
// there is no existing row to right-click for a script that doesn't exist yet. Add Property
// collects three fields at once (#229's own deliberate webview-modal exception), so its command
// only tells the matching panel which script/plugin to open the dialog for — the dialog's own
// confirm builds the fieldPath/op-envelope itself (RecordPanel.tsx). Set Script/Property Flags run
// their own native QuickPick here, seeded (script only — no per-property read model carries a
// current flag) the same way the condition-function picker sorts its own seed to the front.
function registerVmadOpCommands(recordPanels: Set<vscode.WebviewPanel>): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('modbench.vmad.addScript', async (ctx?: VmadScriptsContext) => {
      if (!ctx) return;
      const name = await pickScriptNameViaInputBox();
      if (name == null) return;
      broadcastToRecordPanels(recordPanels, {
        type: EXTENSION_TO_WEBVIEW.VMAD_STRUCTURAL_OP, formKey: ctx.formKey, plugin: ctx.plugin, origin: ctx.origin,
        fieldPath: `VMAD\\${name}`, value: { op: 'add_script' },
      });
    }),
    vscode.commands.registerCommand('modbench.vmad.removeScript', (ctx?: VmadScriptContext) => {
      if (!ctx) return;
      broadcastToRecordPanels(recordPanels, {
        type: EXTENSION_TO_WEBVIEW.VMAD_STRUCTURAL_OP, formKey: ctx.formKey, plugin: ctx.plugin, origin: ctx.origin,
        fieldPath: `VMAD\\${ctx.scriptName}`, value: { op: 'remove_script' },
      });
    }),
    vscode.commands.registerCommand('modbench.vmad.addProperty', (ctx?: VmadScriptContext) => {
      if (!ctx) return;
      broadcastToRecordPanels(recordPanels, {
        type: EXTENSION_TO_WEBVIEW.VMAD_OPEN_ADD_PROPERTY, formKey: ctx.formKey, plugin: ctx.plugin, origin: ctx.origin, scriptName: ctx.scriptName,
      });
    }),
    vscode.commands.registerCommand('modbench.vmad.removeProperty', (ctx?: VmadPropertyContext) => {
      if (!ctx) return;
      broadcastToRecordPanels(recordPanels, {
        type: EXTENSION_TO_WEBVIEW.VMAD_STRUCTURAL_OP, formKey: ctx.formKey, plugin: ctx.plugin, origin: ctx.origin,
        fieldPath: `VMAD\\${ctx.scriptName}\\${ctx.propName}`, value: { op: 'remove_property' },
      });
    }),
    // Issue #231 (review): "seeded with the current value" means the script's own current flag is
    // sorted to the front of the QuickPick's item array — showQuickPick has no activeItem option
    // the way createQuickPick does, so array order is the only way to pre-highlight an item, the
    // same convention pickConditionFunctionViaQuickPick already uses.
    vscode.commands.registerCommand('modbench.vmad.setScriptFlags', async (ctx?: VmadScriptContext) => {
      if (!ctx) return;
      const items = ctx.currentFlags && (VMAD_SCRIPT_FLAGS as readonly string[]).includes(ctx.currentFlags)
        ? [ctx.currentFlags, ...VMAD_SCRIPT_FLAGS.filter(f => f !== ctx.currentFlags)]
        : [...VMAD_SCRIPT_FLAGS];
      const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Script flags' });
      if (!picked) return;
      broadcastToRecordPanels(recordPanels, {
        type: EXTENSION_TO_WEBVIEW.VMAD_STRUCTURAL_OP, formKey: ctx.formKey, plugin: ctx.plugin, origin: ctx.origin,
        fieldPath: `VMAD\\${ctx.scriptName}`, value: { op: 'set_flags', flags: picked },
      });
    }),
    // Issue #231 (review): no current-value seed — VmadPropertyContext (messages.ts) carries none,
    // since the read model never surfaced a per-property flag even before this ticket.
    vscode.commands.registerCommand('modbench.vmad.setPropertyFlags', async (ctx?: VmadPropertyContext) => {
      if (!ctx) return;
      const picked = await vscode.window.showQuickPick([...VMAD_PROP_FLAGS], { placeHolder: 'Property flags' });
      if (!picked) return;
      broadcastToRecordPanels(recordPanels, {
        type: EXTENSION_TO_WEBVIEW.VMAD_STRUCTURAL_OP, formKey: ctx.formKey, plugin: ctx.plugin, origin: ctx.origin,
        fieldPath: `VMAD\\${ctx.scriptName}\\${ctx.propName}`, value: { op: 'set_flags', flags: picked },
      });
    }),
  ];
}

// #428: builds the onRecordEdited callback — pulled out of registerRecordViewCommands purely to
// stay under the lint budget, same reasoning as registerFilterCommands below. Scoped, not
// refresh() (Q1, orchestrator gate ruling): patches the one cached record PluginTreeProvider
// already holds and refreshes only that record's own decoration, so a committed cell edit never
// pays a page-cache invalidation + repository refetch. Hardcodes 'Modified': the edit response
// carries no resulting WorkingTreeState, so the one case this can't see is an edit that converges
// back to the committed bytes (#413's own revert-by-typing convergence) — that row shows a stale M
// until an unrelated refresh corrects it, no worse than every other fact this cache already
// tolerates going stale between refreshes (Q2's own no-watcher posture).
function makeOnRecordEdited(
  treeProvider: PluginTreeProvider, recordDecorationProvider: RecordDecorationProvider, recordPanels: Set<vscode.WebviewPanel>,
): (formKey: string, plugin: string, origin: string) => void {
  return (formKey, plugin, origin) => {
    broadcastToRecordPanels(recordPanels, { type: EXTENSION_TO_WEBVIEW.RECORD_EDITED, formKey });
    if (treeProvider.markWorkingTreeState(plugin, origin, formKey, 'Modified')) {
      // #364 review finding: the M/A badge is location-independent (a local edit is a fact about
      // the record, not about where it's viewed), but the badge-scoping fix gave the Conflicts
      // node's own row a distinct resourceUri from the ordinary one — refresh both, so a record
      // visible in both places at once gets its M/A badge updated in both.
      recordDecorationProvider.refresh(recordResourceUri(plugin, origin, formKey));
      recordDecorationProvider.refresh(recordResourceUri(plugin, origin, formKey, true));
    }
  };
}

// #428: one provider per extension activation (not per panel/command) — its lookup reads
// treeProvider's own cache live, so it never needs its own copy of the same state. Pulled out of
// registerRecordViewCommands (#364, which pushed that function over the lint line budget) purely
// to stay under it, same shape as makeNotifyConflictsComputed above.
function makeRecordDecorationProvider(treeProvider: PluginTreeProvider): RecordDecorationProvider {
  return new RecordDecorationProvider(
    (plugin, origin, formKey) => treeProvider.workingTreeStateOf(plugin, origin, formKey),
    // #364: the conflict badge's own lookup — independent gate, see RecordDecorationProvider's
    // own class doc comment for the M/A-wins precedence.
    (plugin, origin, formKey) => treeProvider.conflictAllOf(plugin, origin, formKey));
}

/** Record view/navigation + filter commands. */
function registerRecordViewCommands(deps: EditorCommandDeps): vscode.Disposable[] {
  const {
    context, openPanels, recordPanels, activeRecordTracker, port, treeProvider, controller, scriptsPath,
    referencedByTreeView, outputChannel,
  } = deps;
  // #410/ADR-0041 retired every per-panel reply bundle along with the pending-change write path
  // they served (the condition-function picker, the revert-group confirm, the add-script input,
  // the clipboard read, the extended field editor all stay retired). #426 restores the first one
  // back — the FormKey picker — so this object is the *shared* remainder; `formKeyPicker` itself
  // is rebuilt per panel at the onDidReceiveMessage call site below, since its reply must reach
  // the one panel that asked, never a broadcast.
  const recordDecorationProvider = makeRecordDecorationProvider(treeProvider);
  const routerDeps: RouteRecordPanelMessageDeps = {
    channel: outputChannel,
    // Issue #224: COPY_TO_CLIPBOARD's ADR-0026 surfacing on a failed clipboard write.
    reporter: makeReporter(outputChannel, 'copyToClipboard'),
    // #415/ADR-0041: the single write path, and the broadcast that tells every open panel showing
    // this record to re-read. Broadcast rather than replying to the one panel that asked: the same
    // record can be open in more than one panel (openEditorBeside), and all of them are now stale.
    repository: deps.repository,
    onRecordEdited: makeOnRecordEdited(treeProvider, recordDecorationProvider, recordPanels),
    // Placeholders — the onDidReceiveMessage wiring below overrides all three per panel every call.
    formKeyPicker: undefined,
    conditionFunctionPicker: undefined,
    extendedFieldEditor: undefined,
  };
  return [
    vscode.window.registerFileDecorationProvider(recordDecorationProvider),
    vscode.commands.registerCommand('modbench.closeMedit', () => exitToLoadout()),
    registerReloadSessionCommand(controller, outputChannel),
    vscode.commands.registerCommand('modbench.openEditor', (args?: { formKey?: string; label?: string }) => {
      openRecordPanel(context, openPanels, args?.label ?? args?.formKey ?? 'mEdit', args?.formKey, port,
        vscode.ViewColumn.One, { routerDeps, recordPanels, activeRecordTracker, singleton: true });
    }),
    // Issue #213/#284: Referenced By's named "Open to the Side" (ADR-0034), not a right-click side
    // effect — also reachable from the Plugins tree's record/placed-reference rows (single or
    // multi-selected). `item`/`allSelected` mirror VS Code's own view/item/context invocation shape
    // (clicked, selected[]), falling back to the Plugins tree's own current selection when neither
    // is supplied (e.g. Command Palette) — same fallback chain modbench.referencedByTree.copy
    // already uses, just against pluginsTreeView instead of referencedByTreeView.
    vscode.commands.registerCommand('modbench.openEditorBeside',
      (item?: RecordNode | PlacedNode | ReferencedByGroupNode | { formKey?: string; label?: string },
        allSelected?: unknown[]) => {
        const nodes: readonly unknown[] = allSelected?.length ? allSelected
          : pluginsTreeView?.selection.length ? pluginsTreeView.selection
          : item ? [item] : [];
        const identities = nodes.map(recordOpenIdentity)
          .filter((i): i is { formKey: string; label: string } => i !== undefined);
        if (identities.length === 0) return;
        openBesideRecordPanels(context, openPanels, identities, port, { routerDeps, recordPanels, activeRecordTracker });
      }),
    vscode.commands.registerCommand('modbench.openCompare', () => {
      openRecordPanel(context, openPanels, 'mEdit', undefined, port, vscode.ViewColumn.One,
        { routerDeps, recordPanels, activeRecordTracker, singleton: true });
    }),
    vscode.commands.registerCommand('modbench.loadMore', (node: InteriorLoadMoreNode) => treeProvider.loadMore(node)),
    ...registerFilterCommands(scriptsPath, controller),
    // #273: reaches every plugin-bearing merged-tree row (modmanager's PluginListNode, not
    // medit's own PluginNode) via pluginFileOf() — the same row-agnostic adapter the composite
    // already uses. Not an immutability decision: reconciling 'pluginImplicit' with medit's
    // 'pluginImmutable' is #276's, not this ticket's.
    vscode.commands.registerCommand('modbench.openHeader', (node?: PluginListNode) => {
      const pluginName = node && pluginFileOf(node);
      if (!pluginName) return;
      void vscode.commands.executeCommand('modbench.openEditor', {
        formKey: headerFormKeyFor(pluginName), label: pluginName,
      });
    }),
    // #282: no longer retargets anything — the view follows activeRecordTracker on its own.
    // Kept as a Command Palette reveal-this-view convenience (issue's own allowance); no menu
    // invokes this anymore (package.json's view/item/context entry is removed).
    vscode.commands.registerCommand('modbench.showReferencedBy',
      () => vscode.commands.executeCommand('modbench.referencedByTree.focus')),
    registerReferencedByCopyCommand(referencedByTreeView, outputChannel),
  ];
}

// #340: modbench.setFilter/setFilterFromDocument/clearFilter — pulled out of
// registerRecordViewCommands purely to stay under the lint budget, same reasoning as
// registerReloadSessionCommand below — no other reason to split it out. The three commands are
// one concern (select/apply/clear the active SQL filter), distinct from the record-panel and
// reveal commands that dominate the rest of that function.
function registerFilterCommands(scriptsPath: string, controller: SessionController): vscode.Disposable[] {
  return [
    // #273 Slice D: modbench.filterPluginTree (issue #70) is gone — it duplicated
    // modbench.pluginListTree.filter over the same rows once the merged tree made this
    // command's own view (modbench.pluginTree) unreachable.
    vscode.commands.registerCommand('modbench.setFilter', async () => {
      const files = fs.existsSync(scriptsPath)
        ? fs.readdirSync(scriptsPath).filter(f => f.endsWith('.sql'))
        : [];
      const NEW_FILTER_LABEL = '$(add) New filter…';
      const items: vscode.QuickPickItem[] = [
        ...files.map(f => ({ label: f, description: scriptsPath })),
        { label: NEW_FILTER_LABEL },
      ];
      const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Select .sql filter file' });
      if (!picked) return;
      if (picked.label === NEW_FILTER_LABEL) {
        const doc = await vscode.workspace.openTextDocument({ language: 'sql' });
        await vscode.window.showTextDocument(doc);
        return;
      }
      const filePath = path.join(scriptsPath, picked.label);
      const sql = fs.readFileSync(filePath, 'utf8');
      await controller.setFilter(sql, picked.label);
    }),
    vscode.commands.registerCommand('modbench.setFilterFromDocument', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const sql = editor.document.getText();
      await controller.setFilter(sql, editor.document.isUntitled ? 'document' : path.basename(editor.document.fileName));
    }),
    vscode.commands.registerCommand('modbench.clearFilter', () => controller.clearFilter()),
    // #363: Filter to Selected Plugins — the ordinary record filter (above), pre-restricted to
    // the tree selection (adopted from xEdit's mniNavFilterApplySelected). VS Code's own
    // `view/item/context` invocation shape: (clicked, selected[]) — pluginNamesInSelection
    // collapses that to the deduped plugin-name set; a selection that names none (e.g. a
    // records-only selection reached via the palette rather than this row's own context menu)
    // is a no-op, since there is nothing to scope the filter to.
    vscode.commands.registerCommand('modbench.pluginListTree.filterToSelected',
      async (clicked?: PluginListNode, selected?: unknown[]) => {
        const names = pluginNamesInSelection(clicked, selected);
        if (names.length === 0) return;
        await controller.setFilter(buildSelectedPluginsFilterSql(names), 'Selected Plugins');
      }),
  ];
}

// #295: modbench.reloadSession — pulled out of registerRecordViewCommands purely for its line
// budget, same reasoning as registerReferencedByCopyCommand below. Re-runs the session load
// (makeEnterEditing — the same path Launch mEdit and the crash-restart handler take), not a
// tree re-read.
// Guarded on enterEditingFn: registerLoadoutView (which builds it) runs before this command is
// even registered, so a set-but-not-yet-assigned race isn't the risk — the guard covers
// enterEditingFn staying permanently unset, which happens when registerLoadoutView returns
// early because there is no workspace, or the workspace isn't an MO2 instance (see that
// function's own early returns). Invoking the command in that state must fail visibly, not
// throw a TypeError at the user.
function registerReloadSessionCommand(controller: SessionController, outputChannel: vscode.LogOutputChannel): vscode.Disposable {
  return vscode.commands.registerCommand('modbench.reloadSession', async () => {
    const enter = enterEditingFn;
    if (!enter) {
      outputChannel.error('[extension] modbench.reloadSession: no editing session to reload (no workspace, or not an MO2 instance)');
      void vscode.window.showErrorMessage('Modbench: There is no editing session to reload.');
      return;
    }
    // #410/ADR-0041: reloads outright, with no confirm. #295's confirm existed only to warn that
    // a reload discards uncommitted work; with that model gone a reload rebuilds read state and
    // destroys nothing.
    //
    // #295 AC4: matches modbench.modList.launchMedit's own try/catch — enterEditing's own
    // undefined-failures branch (loadExplicitSession) already calls exitToLoadout() itself, but
    // every *other* way it can fail (buildExplicitPluginsWithOrigin rethrowing a non-ENOENT readdir
    // error, backendManager.start() rejecting, …) would otherwise propagate unhandled, leaving the
    // tree claiming a session that either never came up or is now half-torn-down.
    try {
      // #307 AC2: the progress indicator moved into enterEditing itself, addressed at the Plugins
      // view's header — two indicators for one operation was noise.
      await enter();
    } catch (err) {
      outputChannel.error(`[extension] reloadSession failed: ${err instanceof Error ? err.message : String(err)}`);
      exitToLoadout();
      void vscode.window.showErrorMessage('Modbench: Failed to reload the session.');
    }
  });
}

// #282: the Referenced By view's own Copy — pulled out of registerRecordViewCommands purely for
// its line budget, same reasoning as createReferencedByTree's own split from `activate`. A
// keybinding (Ctrl+C while focused) and a view/item/context entry both invoke this one command
// (package.json), the same "keybinding + menu, one command" shape modbench.deleteRecord already
// uses; ADR-0034's "no action reachable two ways" is about redundant *affordances* for one action
// (e.g. an inline button duplicating a menu item), not a command having both a keybinding and a
// menu entry. Selection resolution mirrors modbench.deleteRecord: the multi-select array VS Code
// passes when several rows are selected, else the view's own current selection, else the single
// right-clicked node.
function registerReferencedByCopyCommand(
  referencedByTreeView: vscode.TreeView<ReferencedByTreeNode>, outputChannel: vscode.LogOutputChannel,
): vscode.Disposable {
  return vscode.commands.registerCommand('modbench.referencedByTree.copy',
    async (node?: ReferencedByGroupNode, allSelected?: ReferencedByTreeNode[]) => {
      const nodes = allSelected?.length ? allSelected
        : referencedByTreeView.selection.length ? referencedByTreeView.selection
        : node ? [node] : [];
      const text = referencedByCopyText(nodes);
      if (!text) return;
      try {
        await vscode.env.clipboard.writeText(text);
      } catch (err) {
        makeReporter(outputChannel, 'referencedByTree.copy').report(
          'error', 'Could not copy to the clipboard.', err instanceof Error ? err.message : String(err));
      }
    });
}

function broadcastToRecordPanels(recordPanels: Set<vscode.WebviewPanel>, msg: ExtensionToWebview) {
  for (const panel of recordPanels) void panel.webview.postMessage(msg);
}

interface ModListCoreDeps {
  modListProvider: ModListProvider;
  modlistSource: Mo2ModlistSource;
  updateProfileDescription: () => Promise<void>;
  // #307: takes no progress reporter any more — it owns its own, in the Plugins view's header.
  enterEditing: () => Promise<void>;
  outputChannel: vscode.LogOutputChannel;
}
/** Loadout core commands: refresh, switch profile, filter, launch mEdit. */
function registerModListCoreCommands(deps: ModListCoreDeps): vscode.Disposable[] {
  const { modListProvider, modlistSource, updateProfileDescription, enterEditing, outputChannel } = deps;
  return [
      vscode.commands.registerCommand('modbench.modList.view.winningAtTop', () => {
        modListProvider.toggleViewDirection();
        void vscode.commands.executeCommand('setContext', 'modbench.modList.winningAtTop', true);
      }),
      vscode.commands.registerCommand('modbench.modList.view.losingAtTop', () => {
        modListProvider.toggleViewDirection();
        void vscode.commands.executeCommand('setContext', 'modbench.modList.winningAtTop', false);
      }),
      vscode.commands.registerCommand('modbench.modList.switchProfile', async () => {
        const [profiles, active] = await Promise.all([
          modlistSource.listProfiles(),
          modlistSource.getActiveProfile(),
        ]);
        const picked = await vscode.window.showQuickPick(
          profiles.map((p) => ({ label: p, description: p === active ? 'current' : undefined })),
          { placeHolder: 'Switch profile' },
        );
        if (!picked || picked.label === active) return;
        // New session boundary — tear down any live editing backend so a stale
        // session can't survive the profile change (no-op if already stopped).
        exitToLoadout();
        await modListProvider.switchProfile(picked.label);
        void updateProfileDescription();
        loadoutHeaderProvider?.refresh();
      }),
      vscode.commands.registerCommand('modbench.modList.launchMedit', async () => {
        // #270 / #307: enterEditing now puts chevrons on the merged tree's rows *as each plugin
        // lands* rather than all at once at the end, and owns its own progress indicator — in
        // the Plugins view's header, not a notification (AC2). Nothing to wrap here any more.
        try {
          await enterEditing();
        } catch (err) {
          outputChannel.error(`[extension] launchMedit failed: ${err instanceof Error ? err.message : String(err)}`);
          exitToLoadout(); // reset the view and tear down any half-started backend
          void vscode.window.showErrorMessage('Modbench: Failed to enter editing mode.');
        }
      }),
  ];
}

interface ModInstallDeps {
  modlistSource: Mo2ModlistSource;
  runModAction: (label: string, failMessage: string, action: () => Promise<void>) => Promise<void>;
  promptModName: (defaultName: string) => Thenable<string | undefined>;
  warnIfFomod: (name: string, isFomod: boolean) => void;
}
// #340: the three closures registerModInstallCommands needs — pulled out of registerLoadoutView
// purely to stay under the lint budget, no other reason to split it out (same reasoning as
// registerRevealInExplorerCommand). Named for what's already true at the call site, where they're
// handed to registerModInstallCommands as one bundle.
function makeModActionHelpers(
  modListProvider: ModListProvider, outputChannel: vscode.LogOutputChannel,
): Pick<ModInstallDeps, 'runModAction' | 'promptModName' | 'warnIfFomod'> {
  return {
    runModAction: async (logLabel, failMessage, action) => {
      try {
        await action();
        modListProvider.invalidate();
      } catch (err) {
        outputChannel.error(`[extension] ${logLabel} failed: ${err instanceof Error ? err.message : String(err)}`);
        void vscode.window.showErrorMessage(`Modbench: ${failMessage}`);
      }
    },
    // Prompt for a mod name, defaulting to the archive/folder basename.
    promptModName: (defaultName) => vscode.window.showInputBox({ prompt: 'Mod name', value: defaultName }),
    warnIfFomod: (name, isFomod) => {
      if (isFomod)
        void vscode.window.showWarningMessage(
          `Modbench: "${name}" is a FOMOD installer — its files were copied as-is and need manual ` +
            `arrangement (the scripted installer is coming later).`,
        );
    },
  };
}
/** Loadout install commands: from archive, from folder. */
function registerModInstallCommands(deps: ModInstallDeps): vscode.Disposable[] {
  const { modlistSource, runModAction, promptModName, warnIfFomod } = deps;
  return [
      vscode.commands.registerCommand('modbench.modList.installFromArchive', async (archivePath?: string): Promise<boolean> => {
        let archive = archivePath;
        if (!archive) {
          const picked = await vscode.window.showOpenDialog({
            canSelectMany: false,
            filters: { 'Mod archives': ['zip', '7z', 'rar'] },
            openLabel: 'Install',
          });
          archive = picked?.[0]?.fsPath;
        }
        if (!archive) return false;
        const resolvedArchive = archive;
        const name = await promptModName(path.basename(resolvedArchive).replace(/\.(zip|7z|rar)$/i, ''));
        if (!name) return false;
        let succeeded = false;
        await runModAction('installFromArchive', `Failed to install "${name}".`, async () => {
          const staging = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'medit-install-'));
          try {
            await extractArchive(resolvedArchive, staging);
            const { sourceDir, isFomod } = await detectRoot(staging);
            await modlistSource.installMod(name, sourceDir, { installationFile: path.basename(resolvedArchive) });
            warnIfFomod(name, isFomod);
            succeeded = true;
          } finally {
            await fs.promises.rm(staging, { recursive: true, force: true });
          }
        });
        return succeeded;
      }),
      vscode.commands.registerCommand('modbench.modList.installFromFolder', async () => {
        const picked = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          openLabel: 'Install',
        });
        const folder = picked?.[0]?.fsPath;
        if (!folder) return;
        const name = await promptModName(path.basename(folder));
        if (!name) return;
        await runModAction('installFromFolder', `Failed to install "${name}".`, async () => {
          const { sourceDir, isFomod } = await detectRoot(folder);
          await modlistSource.installMod(name, sourceDir, {});
          warnIfFomod(name, isFomod);
        });
      }),
  ];
}

interface ModContextDeps {
  instanceRoot: string;
  modlistSource: Mo2ModlistSource;
  outputChannel: vscode.LogOutputChannel;
  runModAction: (label: string, failMessage: string, action: () => Promise<void>) => Promise<void>;
}
/** Loadout per-mod context commands: reveal, separator ops, uninstall, Nexus. */
function registerModContextCommands(deps: ModContextDeps): vscode.Disposable[] {
  const { instanceRoot, modlistSource, outputChannel, runModAction } = deps;
  return [
      vscode.commands.registerCommand('modbench.modList.mod.openInExplorer', async (node: ModNode) => {
        if (node?.kind !== 'mod') return;
        const uri = vscode.Uri.file(path.join(instanceRoot, 'mods', node.mod.name));
        await vscode.commands.executeCommand('revealInExplorer', uri);
      }),
      vscode.commands.registerCommand('modbench.modList.mod.addSeparatorBelow', async (node: ModNode) => {
        if (node?.kind !== 'mod') return;
        const name = await vscode.window.showInputBox({ prompt: 'Separator name', placeHolder: 'My Group' });
        if (!name) return;
        await runModAction('addSeparatorBelow', 'Failed to add separator.', () => modlistSource.insertSeparator(name, node.mod.name));
      }),
      vscode.commands.registerCommand('modbench.modList.mod.moveToSeparator', async (node: ModNode) => {
        if (node?.kind !== 'mod') return;
        let separators: string[];
        try {
          separators = await modlistSource.listSeparators();
        } catch (err) {
          outputChannel.error(`[extension] moveToSeparator listSeparators failed: ${err instanceof Error ? err.message : String(err)}`);
          void vscode.window.showErrorMessage(`Modbench: Failed to read mod list.`);
          return;
        }
        const items: Array<vscode.QuickPickItem & { sepName: string | null }> = [
          { label: 'Ungrouped', description: 'Before first separator', sepName: null },
          ...separators.map((s) => ({ label: s, sepName: s })),
        ];
        const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Move to separator…' });
        if (!picked) return;
        await runModAction('moveToSeparator', 'Failed to move mod.', () => modlistSource.moveModToSeparator(node.mod.name, picked.sepName));
      }),
      vscode.commands.registerCommand('modbench.modList.mod.uninstall', async (node: ModNode) => {
        if (node?.kind !== 'mod') return;
        const answer = await vscode.window.showWarningMessage(
          `Uninstall "${node.mod.name}"? This will permanently delete the mod folder from disk.`,
          { modal: true },
          'Uninstall',
        );
        if (answer !== 'Uninstall') return;
        await runModAction('uninstall', `Failed to uninstall "${node.mod.name}".`, () => modlistSource.removeMod(node.mod.name));
      }),
      vscode.commands.registerCommand('modbench.modList.mod.viewOnNexus', async (node: ModNode) => {
        if (node?.kind !== 'mod' || !node.mod.nexusId) return;
        const nexusId = node.mod.nexusId;
        await runModAction('viewOnNexus', 'Failed to open Nexus page.', async () => {
          const slug = await modlistSource.getNexusSlug();
          await vscode.env.openExternal(
            vscode.Uri.parse(`https://www.nexusmods.com/${slug}/mods/${nexusId}`),
          );
        });
      }),
  ];
}

interface SeparatorCmdDeps {
  modlistSource: Mo2ModlistSource;
  runModAction: (label: string, failMessage: string, action: () => Promise<void>) => Promise<void>;
}
/** Loadout separator context commands: rename, add-below, delete. */
function registerSeparatorCommands(deps: SeparatorCmdDeps): vscode.Disposable[] {
  const { modlistSource, runModAction } = deps;
  return [
      vscode.commands.registerCommand('modbench.modList.separator.rename', async (node: SeparatorNode) => {
        if (node?.kind !== 'separator') return;
        const newName = await vscode.window.showInputBox({
          prompt: 'Rename separator',
          value: node.separator.name,
        });
        if (!newName || newName === node.separator.name) return;
        await runModAction('renameSeparator', 'Failed to rename separator.', () => modlistSource.renameSeparator(node.separator.name, newName));
      }),
      vscode.commands.registerCommand('modbench.modList.separator.addSeparatorBelow', async (node: SeparatorNode) => {
        if (node?.kind !== 'separator') return;
        const name = await vscode.window.showInputBox({ prompt: 'Separator name', placeHolder: 'My Group' });
        if (!name) return;
        await runModAction('separator.addSeparatorBelow', 'Failed to add separator.', () => modlistSource.insertSeparator(name, node.separator.name));
      }),
      vscode.commands.registerCommand('modbench.modList.separator.delete', async (node: SeparatorNode) => {
        if (node?.kind !== 'separator') return;
        await runModAction('deleteSeparator', 'Failed to delete separator.', () => modlistSource.deleteSeparator(node.separator.name));
      }),
  ];
}


interface PluginListDeps {
  modlistSource: Mo2ModlistSource;
  log: (msg: string) => void;
  outputChannel: vscode.LogOutputChannel;
  reporter: Reporter;
  instanceRoot: string;
  // #357: a getter through the single game-directory resolver, not a Promise settled once —
  // see ModListProviderOptions/PluginListProviderOptions for why. Folds a resolution failure to
  // undefined (degrading vanilla-master lookups/badges), unlike `gameDirResolver` below.
  dataFolder: () => Promise<string | undefined>;
  // #357: the same resolver `dataFolder` reads through, passed through raw (not folded to
  // undefined on failure) for the drift tracker below — #334 relies on a thrown resolution
  // reaching its own try/catch so a failed refresh keeps the last known drift state rather than
  // reading a misconfigured directory as "nothing resolves".
  gameDirResolver: GameDirectoryResolver;
  /** The record browser that supplies a plugin row's children (#270). Passed as the composite's
   *  child source and never touched directly here. */
  recordBrowser: PluginTreeProvider;
  /** #279 / #356: the per-plugin re-read's HTTP half, injected into the drift tracker so an origin
   *  change is absorbed automatically — there is no longer a command that calls this directly. */
  controller: SessionController;
}
/** The Plugins tree: a view of plugins.txt, stacked below the Mods tree. A row's checkbox toggles
 *  its enabled state (writing plugins.txt immediately); rows drag-and-drop to reorder (single or
 *  multi-select, writing plugins.txt immediately); a title-bar Refresh forces a re-read.
 *  `instanceRoot` enables the order-aware missing-master badge (issue #67).
 *
 *  #270 / ADR-0035: the view is now a `PluginsTreeComposite` over two providers — these rows and
 *  the record browser's children — so that with a session running each row expands into its
 *  records. The composite is built here, at the composition root, because it is the only place
 *  that may know both; `PluginListProvider` is unchanged and still owns everything about a row. */
/** The Plugins tree's own `PluginsTreeComposite` construction, pulled out of
 *  `registerPluginListView` (#448, which pushed that function over the lint budget) purely to stay
 *  under it — no other reason to split it out, same as `registerRevealInExplorerCommand` alongside
 *  it. */
function buildPluginsTreeComposite(
  pluginListProvider: PluginListProvider, recordBrowser: PluginTreeProvider,
): PluginsTreeComposite<PluginListNode, PluginTreeNode> {
  return new PluginsTreeComposite<PluginListNode, PluginTreeNode>({
    rows: pluginListProvider,
    // #448: a thin positional adapter, not `recordBrowser` passed directly — the composite's own
    // `getPluginChildren(pluginFile, stackPeers?)` contract has no `origin` slot (a root row never
    // has one to give; only a peer's own *recursive* expansion inside PluginTreeProvider ever
    // supplies one, entirely internal to that class), while `PluginTreeProvider.getPluginChildren`
    // keeps its existing three-parameter shape for that recursion and its own test suite. Nothing
    // else about `recordBrowser`'s identity is used as `children` outside this call.
    children: {
      getPluginChildren: (file, stackPeers) => recordBrowser.getPluginChildren(file, undefined, stackPeers),
      getChildren: (child) => recordBrowser.getChildren(child),
      getTreeItem: (child) => recordBrowser.getTreeItem(child),
      onDidChangeTreeData: recordBrowser.onDidChangeTreeData,
      // #364: the root-level Conflicts node — a thin relay to PluginTreeProvider's own gate
      // (conflictsComputed), same "the composite decides nothing, only relays" posture every
      // other member of this adapter object already has.
      conflictsNode: () => recordBrowser.conflictsNode(),
    },
    pluginFileOf,
    // #277 / ADR-0037 AC8: lets the composite reconcile the order-aware badge with session state
    // by master name, instead of two decorations that can disagree.
    orderIssueMastersOf,
    // #278 / ADR-0035 amending ADR-0018: matchingPlugins is refreshed off the module-level
    // refreshMatchingPlugins function above, whenever SessionController's setFilter/clearFilter
    // run. Undefined (never fetched, or the accessor finds nothing for this file) reads as
    // "matches" — the composite's own fallback for an accessor that has nothing to say.
    hasMatchingRecords: (file) => matchingPlugins?.get(file.toLowerCase()),
    // #448: hands a contested row's file-level peers through to the record browser, which builds
    // the pinned-first Stack node from them — live against PluginListProvider's own stackPeers()
    // for the same "never drifts from what the tree rendered" reason fileOverrides() above is.
    stackPeersOf: (row) => {
      const file = pluginFileOf(row);
      return file === undefined ? undefined : pluginListProvider.stackPeers().get(file.toLowerCase());
    },
  });
}

function registerPluginListView(deps: PluginListDeps): { pluginListProvider: PluginListProvider; disposables: vscode.Disposable[] } {
  const { modlistSource, log, outputChannel, reporter, instanceRoot, dataFolder, gameDirResolver, recordBrowser, controller } = deps;
  const pluginListProvider = new PluginListProvider({ source: modlistSource, log, reporter, instanceRoot, dataFolder });
  const tracker = makeDriftTracker(modlistSource, instanceRoot, outputChannel, gameDirResolver, controller);
  driftTracker = tracker;
  const composite = buildPluginsTreeComposite(pluginListProvider, recordBrowser);
  pluginsTree = composite;
  clearSessionWhenBackendDies(composite, recordBrowser, tracker);
  const pluginListView = vscode.window.createTreeView('modbench.pluginListTree', {
    treeDataProvider: composite,
    canSelectMany: true,
    // Still the row provider's: a drag moves plugins.txt lines, which is a Mod-Management
    // concern whether or not the rows happen to have children today.
    dragAndDropController: pluginListProvider,
    // #247 rule 7: hierarchical trees get Collapse All. This one became hierarchical with #270 —
    // plugin → record type → record — so it earns the affordance the editing tree already had.
    showCollapseAll: true,
  });
  pluginsTreeView = pluginListView; // #307: see its declaration — progress and message live here
  pluginsNameFilter = registerPluginsNameFilter(pluginListView, pluginListProvider);
  return { pluginListProvider, disposables: [
    pluginListView,
    composite,
    // #276: grays an implicit master's row the way MO2 grays COL_NAME for a forceLoaded
    // plugin (ImplicitMasterDecorationProvider's own comment) — keyed off the same
    // dataFolder this view already resolves, live against PluginListProvider's own
    // implicitMasterNames() so it never drifts from what the tree actually rendered.
    vscode.window.registerFileDecorationProvider(
      new ImplicitMasterDecorationProvider(dataFolder, () => pluginListProvider.implicitMasterNames()),
    ),
    // #447: badges + tints a file-override row (git-modified idiom) — live against
    // PluginListProvider's own fileOverrides() so it never drifts from what the tree rendered.
    vscode.window.registerFileDecorationProvider(
      new FileOverrideDecorationProvider(() => pluginListProvider.fileOverrides()),
    ),
    ...wireDriftTracker(tracker, instanceRoot),
    pluginListView.onDidChangeCheckboxState(async (e) => {
      for (const [node, state] of e.items) {
        if (node.kind !== 'plugin') continue;
        try {
          await pluginListProvider.setPluginEnabled(node.plugin.name, state === vscode.TreeItemCheckboxState.Checked);
        } catch (err) {
          // ADR-0026: a failed user action must surface, not silently leave the checkbox
          // out of sync with disk. Log detail, notify, and refresh to resync the checkbox.
          outputChannel.error(`[extension] toggling "${node.plugin.name}" failed: ${err instanceof Error ? err.message : String(err)}`);
          void vscode.window.showErrorMessage(`Modbench: Failed to update "${node.plugin.name}".`);
          pluginListProvider.invalidate();
        }
      }
    }),
    registerRevealInExplorerCommand(pluginListProvider, outputChannel),
    registerParticipationLiveMutation(pluginListProvider, controller),
    pluginsNameFilter,
    // #448 / #34: a Stack peer's collapse is the unlisted-plugin door's own mirror of its
    // expand-time load — dropping the loaded copy so a browsed-then-abandoned peer never lingers
    // in the session ("hidden means absent"). `unloadStackPeer` is itself a no-op for a peer that
    // was never expanded, so this fires for every collapse without first checking which kind.
    pluginListView.onDidCollapseElement((e) => {
      if (e.element instanceof StackPeerNode) void recordBrowser.unloadStackPeer(e.element);
    }),
  ] };
}

/** `modbench.pluginListTree.revealInExplorer`: pulled out of `registerPluginListView` (#278,
 *  which pushed that function over the lint budget) purely to stay under it — no other reason to
 *  split it out, same as `registerRereadCommand` alongside it. */
function registerRevealInExplorerCommand(
  pluginListProvider: PluginListProvider, outputChannel: vscode.LogOutputChannel,
): vscode.Disposable {
  return vscode.commands.registerCommand('modbench.pluginListTree.revealInExplorer', async (node: PluginListNode) => {
    if (node?.kind !== 'plugin') return;
    const name = node.plugin.name;
    const filePath = await pluginListProvider.resolvePluginPath(name);
    if (!filePath) {
      // ADR-0026: an explicit user action failed — notify + log, never a silent no-op.
      outputChannel.error(`[extension] revealInExplorer could not resolve a path for "${name}"`);
      void vscode.window.showErrorMessage(`Modbench: Could not resolve a file location for "${name}".`);
      return;
    }
    try {
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(filePath));
    } catch (err) {
      outputChannel.error(`[extension] revealInExplorer for "${name}" failed: ${err instanceof Error ? err.message : String(err)}`);
      void vscode.window.showErrorMessage(`Modbench: Failed to reveal "${name}" in Explorer.`);
    }
  });
}

/** #97 / ADR-0035 § Live mutation: the checkbox gesture's other half — applies the same
 *  participation change `PluginListProvider.setPluginEnabled` just wrote to `plugins.txt` onto a
 *  running backend session, live, with the Plugins view's own header progress indicator as the
 *  only feedback (`withPluginsViewProgress`, AC7). A no-op when no backend session is loaded
 *  (`pluginsTree.hasSession()`) — Mod Management works with no backend running, and that is the
 *  ordinary case, not a failure to report (`PluginsTreeComposite.hasSession`'s own doc comment) —
 *  so this never even attempts the call rather than surfacing it as a network-error toast.
 *  `pluginsTree` is read fresh on every event rather than closed over at registration time,
 *  since it is reassigned by every `enterEditing`/`exitToLoadout` cycle a session's whole
 *  lifetime after this listener is wired.
 *
 *  Pulled out of `registerPluginListView` purely to keep that function under the lint line
 *  budget, same as `registerRevealInExplorerCommand` alongside it. */
function registerParticipationLiveMutation(
  pluginListProvider: PluginListProvider, controller: SessionController,
): vscode.Disposable {
  return pluginListProvider.onDidChangeParticipation(({ plugin, enabled }) => {
    if (!pluginsTree?.hasSession()) return;
    void withPluginsViewProgress(async () => {
      await controller.setPluginParticipation(plugin, enabled);
    });
  });
}

/** `modbench.pluginListTree.revealInModsTree` (#448 AC5): a Stack peer's own "jump to the
 *  providing mod" gesture — changing the winner is mod reordering, the Mods tree's own
 *  jurisdiction, so this only ever selects/focuses a row there, never offers a reorder from the
 *  Plugins tree. `modListProvider.findModNode` resolves the peer's `origin` to the actual node
 *  the Mods tree's own `getChildren` produced (root-level or nested under a separator);
 *  `modListView.reveal` needs that exact node, plus `ModListProvider.getParent` (#448), to walk
 *  the ancestor chain for a grouped mod. */
function registerRevealInModsTreeCommand(
  modListProvider: ModListProvider, modListView: vscode.TreeView<ModlistNode>, outputChannel: vscode.LogOutputChannel,
): vscode.Disposable {
  return vscode.commands.registerCommand('modbench.pluginListTree.revealInModsTree', async (node?: StackPeerNode) => {
    if (!(node instanceof StackPeerNode)) return;
    const modName = node.peer.origin;
    try {
      const target = await modListProvider.findModNode(modName);
      if (!target) {
        // ADR-0026: an explicit user action failed — notify + log, never a silent no-op.
        outputChannel.error(`[extension] revealInModsTree could not find a mod row for "${modName}"`);
        void vscode.window.showErrorMessage(`Modbench: Could not find "${modName}" in the Mods tree.`);
        return;
      }
      await modListView.reveal(target, { select: true, focus: true, expand: true });
    } catch (err) {
      outputChannel.error(`[extension] revealInModsTree for "${modName}" failed: ${err instanceof Error ? err.message : String(err)}`);
      void vscode.window.showErrorMessage(`Modbench: Failed to reveal "${modName}" in the Mods tree.`);
    }
  });
}

/** Every plugin-row command (Track, Save & Compile, compile-at-ref, Rebase, the #427 lifecycle
 *  gestures) grouped so `activate()` stays under its own size budget — same reasoning as
 *  `registerEditorCommands`'s own grouping, one level up (plugin-tree rows rather than the record
 *  editor's own commands). */
function registerPluginRowCommands(
  controller: SessionController,
  repository: ApiPluginRepository,
  activeRecordTracker: ActiveRecordTracker<vscode.WebviewPanel>,
  outputChannel: vscode.LogOutputChannel,
  compileDiagnostics: vscode.DiagnosticCollection,
): vscode.Disposable[] {
  return [
    registerTrackCommand(controller, outputChannel, () => registerTrackedRepositoriesForSession(repository, outputChannel)),
    registerSaveAndCompileCommand(controller, repository, activeRecordTracker, outputChannel, compileDiagnostics),
    registerCompileAtRefCommand(controller, outputChannel, compileDiagnostics),
    registerRebaseCommand(controller, repository, outputChannel),
    ...registerRecordLifecycleCommands(controller, repository, outputChannel),
    ...registerRecordCopyCommands(controller, repository, outputChannel),
    // #448 AC4: the Stack node's own binary-entry action — Save & Compile is already reachable
    // there via the widened modbench.saveAndCompile handler above, registered once for every
    // caller.
    registerDiffAgainstSourceCommand(repository, outputChannel),
  ];
}

/** #414/ADR-0041: the Track gesture. Resolves the clicked row's plugin name to the mod folder the
 *  session actually loaded it from, asks which `.gitignore` preset to generate (Edits is the
 *  default — Everything is the opt-in authoring choice), then delegates the HTTP call to
 *  `SessionController`. `onTracked` re-registers the native SCM panel for the newly tracked repo
 *  immediately, without waiting for the next activation.
 *
 *  AC: "reports progress" — a mega-plugin's complete serialization is a one-time, worst-case
 *  tens-of-seconds cost (ADR-0041), so the whole `track` call runs under the same Plugins-view
 *  progress indicator #307 already built for the other long, blocking-POST operation this view
 *  has (the session load) — same surface, same `say` narration, no second bespoke indicator. */
function registerTrackCommand(
  controller: SessionController, outputChannel: vscode.LogOutputChannel, onTracked: () => Promise<void>,
): vscode.Disposable {
  return vscode.commands.registerCommand('modbench.pluginListTree.track', async (node: PluginListNode) => {
    if (node?.kind !== 'plugin') return;
    const name = node.plugin.name;
    const origin = await controller.resolveOrigin(name);
    if (!origin) {
      // ADR-0026: an explicit user action failed — notify + log, never a silent no-op.
      outputChannel.error(`[extension] track could not resolve an origin for "${name}"`);
      void vscode.window.showErrorMessage(`Modbench: Could not resolve which mod "${name}" belongs to.`);
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

    await withPluginsViewProgress(async () => {
      say(trackProgressMessage(origin, { phase: 'Idle', pluginsDone: 0, pluginsTotal: 0 }));
      const ok = await controller.track(origin, choice.label as 'Edits' | 'Everything', {
        // #414 review F2: "reports progress" (AC4) — narrates the same Plugins-view message this
        // command already showed a static version of, updated on each poll tick.
        onProgress: (status) => say(trackProgressMessage(origin, status)),
      });
      if (!ok) return;
      void vscode.window.showInformationMessage(`Modbench: Tracked "${origin}".`);
      await onTracked();
    });
  });
}

/** #288 / ADR-0041: New Plugin's destination QuickPick — the composition root joining both
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
    // Accepted residue (#288 review), the frontend's twin of PluginEndpoints.CreatePlugin's own
    // GitUnavailableException-catch comment: the mod folder is registered here, before the create
    // POST below even runs. If that POST then fails, the mod stays registered — empty and
    // disabled, same as any fresh install — rather than being rolled back. Visible in the Mods
    // tree, harmless, and the user's own delete-the-mod-folder undoes it; not engineered around,
    // per the ruling.
    await modlistSource.installMod(modName, staging, {});
  } finally {
    await fs.promises.rm(staging, { recursive: true, force: true });
  }
  return resolvePluginDestination(instanceRoot, { kind: 'newMod', modName });
}

/** #288 / ADR-0041: `modbench.newPlugin` — creation lands as tracked working-tree text. Editing's
 *  create endpoint writes the file, Tracks the destination if needed, and indexes it; only once
 *  that has actually succeeded does Mod Management's own writer (`appendPlugin`) add the load-order
 *  line — never the other way around, so the load order can never name a file that doesn't yet
 *  exist. Registered unconditionally (the command exists in every activation), but needs a live
 *  Loadout to have anywhere to put the plugin — the Plugins tree it's contributed to
 *  (`modbench.pluginListTree`) only renders with one anyway, so the guard below is defensive, not
 *  the normal path. */
// Split out of registerCreatePluginCommand purely to stay under its complexity budget (same
// reasoning as registerFilterCommands/makeOnRecordEdited elsewhere in this file) — the load-order
// append and its own failure mode (created but unregistered — a real, surfaced state, not silently
// dropped) is one coherent step.
async function appendCreatedPluginToLoadOrder(
  modlistSource: Mo2ModlistSource, pluginListProvider: PluginListProvider, pluginName: string, outputChannel: vscode.LogOutputChannel,
): Promise<void> {
  try {
    await modlistSource.appendPlugin(pluginName);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    outputChannel.error(`[extension] newPlugin: created "${pluginName}" but could not add it to plugins.txt: ${message}`);
    void vscode.window.showErrorMessage(
      `Modbench: Created "${pluginName}", but could not add it to the load order — add it manually in the Plugins tree.`,
    );
    pluginListProvider.invalidate();
    return;
  }
  pluginListProvider.invalidate();
  void vscode.window.showInformationMessage(`Modbench: Created "${pluginName}".`);
}

function registerCreatePluginCommand(
  controller: SessionController,
  modlistSource: Mo2ModlistSource | undefined,
  instanceRoot: string | undefined,
  pluginListProvider: PluginListProvider | undefined,
  outputChannel: vscode.LogOutputChannel,
): vscode.Disposable {
  return vscode.commands.registerCommand('modbench.newPlugin', async () => {
    if (!modlistSource || !instanceRoot || !pluginListProvider) {
      outputChannel.error('[extension] newPlugin: no Loadout available — need an open MO2 instance workspace.');
      void vscode.window.showErrorMessage('Modbench: New Plugin needs an open MO2 instance workspace.');
      return;
    }

    const name = await promptPluginName();
    if (!name) return;

    let destination: { path: string; origin: string } | undefined;
    try {
      destination = await pickPluginDestination(modlistSource, instanceRoot);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      outputChannel.error(`[extension] newPlugin: could not prepare the destination: ${message}`);
      void vscode.window.showErrorMessage(`Modbench: Could not prepare the destination — ${message}`);
      return;
    }
    if (!destination) return; // user cancelled a prompt

    // SessionController.createPlugin already surfaces its own failure (ADR-0026) — nothing more
    // to do here than stop.
    const created = await controller.createPlugin(name, destination.path, destination.origin);
    if (!created) return;

    await appendCreatedPluginToLoadOrder(modlistSource, pluginListProvider, created.name, outputChannel);
  });
}

/** #427: the three lifecycle gestures — create, delete, renumber — as Plugins-tree row commands on
 *  the record browser (ADR-0034: xEdit hosts Add/Remove/Change FormID in its own tree's context
 *  menu, not the grid — this is the tree, not the record editor's field grid). Titled to match
 *  xEdit's own captions exactly ("Add" / "Remove" / "Change FormID…", `xeMainForm.dfm`'s
 *  `mniNavAdd`/`mniNavRemove`/`mniNavChangeFormID`).
 *
 *  Each resolves the clicked row's origin the same way `registerTrackCommand` does (a node's own
 *  `origin` when the row already carries it, else `controller.resolveOrigin` — undefined means an
 *  ordinary load-order plugin, per ADR-0036) — there is no ambient fallback worth a QuickPick, which
 *  is why all three are palette-gated (`packageJson.test.ts`'s `PALETTE_GATED`). */
function registerRecordLifecycleCommands(
  controller: SessionController, repository: PluginRepository, outputChannel: vscode.LogOutputChannel,
): vscode.Disposable[] {
  const resolveOriginOrReport = makeResolveOriginOrReport(controller, outputChannel);

  return [
    // xEdit's own "Add": zero friction, no prompt — a blank record appears immediately, named
    // after the fact by editing its EditorID field like any other, matching xEdit's own gesture
    // (EditTips: no modal confirmation on edit beyond the one-time EditWarn).
    vscode.commands.registerCommand('modbench.record.create', async (node?: RecordTypeNode) => {
      if (node?.kind !== 'recordType') return;
      const origin = await resolveOriginOrReport({ origin: node.origin, pluginName: node.plugin });
      if (!origin) return;

      const formKey = await controller.createRecord(node.plugin, origin, node.recordType);
      if (formKey) void vscode.window.showInformationMessage(`Modbench: Added ${formKey}.`);
    }),

    // xEdit's own "Remove": MessageDlg('Are you sure you want to permanently remove <Name>?',
    // mtConfirmation, [mbYes, mbNo]) — the native modal equivalent, naming the same record identity
    // xEdit's own confirmation does, so the user confirms the right thing.
    vscode.commands.registerCommand('modbench.record.delete', async (node?: RecordNode) => {
      if (node?.kind !== 'record') return;
      const origin = await resolveOriginOrReport({ origin: node.origin, pluginName: node.record.plugin });
      if (!origin) return;

      const label = node.record.editorId ? `${node.record.editorId} [${node.record.formKey}]` : node.record.formKey;
      const choice = await vscode.window.showWarningMessage(
        `Are you sure you want to permanently remove ${label}?`, { modal: true }, 'Remove',
      );
      if (choice !== 'Remove') return;

      await controller.deleteRecord(node.record.formKey, node.record.plugin, origin);
    }),

    // xEdit's own "Change FormID": InputQuery('New FormID', ...) — a native InputBox, prefilled with
    // the both-refs next-free suggestion (xEdit's own "New FormID generated" flow) so accepting the
    // default is a single Enter; typing over it is xEdit's typed-FormID path, validated server-side.
    vscode.commands.registerCommand('modbench.record.renumber', async (node?: RecordNode) => {
      if (node?.kind !== 'record') return;
      const origin = await resolveOriginOrReport({ origin: node.origin, pluginName: node.record.plugin });
      if (!origin) return;

      let suggested: string | undefined;
      try {
        suggested = await repository.peekNextFreeFormKey(node.record.plugin, origin);
      } catch (e) {
        // Background/recoverable (ADR-0026): the input box still works with no prefill, so this is
        // a log line, not a toast — the command is not blocked on it.
        outputChannel.warn(`[extension] record.renumber could not fetch a suggested FormKey: ${e instanceof Error ? e.message : String(e)}`);
      }

      const input = await vscode.window.showInputBox({
        prompt: `New FormID for ${node.record.formKey}`,
        value: suggested,
        valueSelection: undefined,
      });
      if (input === undefined) return; // cancelled

      const newFormKey = await controller.renumberRecord(node.record.formKey, node.record.plugin, origin, input || undefined);
      if (newFormKey) void vscode.window.showInformationMessage(`Modbench: Renumbered to ${newFormKey}.`);
    }),
  ];
}

/** #427: shared by `registerRecordLifecycleCommands` and `registerRecordCopyCommands` — a node's
 *  own `origin` when the row already carries it (ADR-0036), else `controller.resolveOrigin`;
 *  reports and returns undefined when neither answers (there is no ambient fallback worth a
 *  QuickPick, which is why every command that needs this is palette-gated). */
function makeResolveOriginOrReport(
  controller: SessionController, outputChannel: vscode.LogOutputChannel,
): (node: { origin?: string; pluginName: string }) => Promise<string | undefined> {
  return async (node) => {
    const origin = node.origin ?? await controller.resolveOrigin(node.pluginName);
    if (!origin) {
      outputChannel.error(`[extension] record lifecycle command could not resolve an origin for "${node.pluginName}"`);
      void vscode.window.showErrorMessage(`Modbench: Could not resolve which mod "${node.pluginName}" belongs to.`);
    }
    return origin;
  };
}

/** #436/#494 (xEdit parity: xeMainForm.pas's CopyInto, reached from both mniNavCopyIntoClick — the
 *  tree row — and mniViewHeaderCopyIntoClick — the column header): one command per gesture,
 *  registered once, reached from either entry point. `arg` is a plugins-tree RecordNode or the
 *  column header's own ColumnHeaderContext (its data-vscode-context payload) — resolved to the
 *  same {formKey, plugin, origin} identity either way (recordCopyIdentity below), so everything
 *  past that point is one implementation path regardless of which row was right-clicked (#281's
 *  original unification, preserved). Split out of registerRecordLifecycleCommands purely for that
 *  function's own line budget, same reason registerArrayOpCommands/registerVmadOpCommands split
 *  off registerEditorCommands. */
function registerRecordCopyCommands(
  controller: SessionController, repository: PluginRepository, outputChannel: vscode.LogOutputChannel,
): vscode.Disposable[] {
  const resolveOriginOrReport = makeResolveOriginOrReport(controller, outputChannel);

  return [
    vscode.commands.registerCommand('modbench.record.copyAsOverride', async (arg?: RecordNode | ColumnHeaderContext) => {
      await runCopyRecordCommand('copy-as-override', arg, controller, repository, resolveOriginOrReport, outputChannel);
    }),
    vscode.commands.registerCommand('modbench.record.copyAsNewRecord', async (arg?: RecordNode | ColumnHeaderContext) => {
      await runCopyRecordCommand('copy-as-new', arg, controller, repository, resolveOriginOrReport, outputChannel);
    }),
  ];
}

/** #436/#494: the plugins-tree row and column-header entry points' shared identity — a
 *  `RecordNode` names it via its own `record.plugin`, a `ColumnHeaderContext` (the header's
 *  `data-vscode-context` payload) names it directly. Undefined for anything else (a `RecordNode`
 *  whose `kind` isn't `'record'` — the command is only ever contributed on a record row, but a
 *  stale/mistyped invocation should still resolve to nothing rather than throw). */
function recordCopyIdentity(
  arg: RecordNode | ColumnHeaderContext | undefined,
): { formKey: string; plugin: string; origin?: string } | undefined {
  if (!arg) return undefined;
  if ('kind' in arg) return arg.kind === 'record' ? { formKey: arg.record.formKey, plugin: arg.record.plugin, origin: arg.origin } : undefined;
  return { formKey: arg.formKey, plugin: arg.plugin, origin: arg.origin };
}

/** #436/#494: the destination QuickPick both copy commands share — candidates are
 *  `copyTargetPlugins`' own gesture-aware filter (immutable always excluded; every plugin already
 *  carrying the record excluded too, but only for 'copy-as-override' — xEdit parity,
 *  xeMainForm.pas:3023-3042). No "New Plugin…" entry, unlike #209's own retired picker: "copy into
 *  a new file" is out of scope (#494). Returns the picked `PluginMetadata` (not just its name) so
 *  the caller reads `.origin` straight off it — a second `resolveOrigin` round trip for the
 *  destination would be redundant, `repository.getPlugins()` already answers it.
 *
 *  #534: unlike `resolveOriginOrReport`'s call above it in `runCopyRecordCommand` (which the
 *  invoking row's own carried `origin` usually lets it skip entirely), this step's two repository
 *  calls are unconditional — the real exposure window is the backend dying after the copy
 *  surfaces (a record row, or the record-header webview) have already rendered, which needs a
 *  live session and so isn't reachable pre-launch. Either awaited call rejecting is deliberately
 *  caught wholesale — this destination-picking step has no further fallback tier below it, the
 *  same "no tier left, so report and resolve to no target" posture `resolveCompileTarget`'s own
 *  #530 fix gives its `pickPlugin` tier — and any rejection gets the same treatment, not just a
 *  transport failure, since nothing past this point can tell the two apart usefully. */
async function pickCopyDestination(
  repository: PluginRepository, gesture: CopyGesture, formKey: string, outputChannel: vscode.LogOutputChannel,
): Promise<{ name: string; origin: string } | undefined> {
  try {
    const allPlugins = await repository.getPlugins();
    const carrying = gesture === 'copy-as-override' ? await repository.getRecordOverridePlugins(formKey) : [];
    const candidates = copyTargetPlugins(allPlugins, gesture, carrying);
    if (candidates.length === 0) {
      void vscode.window.showInformationMessage('Modbench: No eligible destination plugin for this copy.');
      return undefined;
    }
    const items = candidates.map((p) => ({ label: p.name, description: `[${p.loadOrderIndex}]`, plugin: p }));
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: gesture === 'copy-as-override' ? 'Copy as Override Into…' : 'Copy as New Record Into…',
    });
    return picked && { name: picked.plugin.name, origin: picked.plugin.origin };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    outputChannel.error(`[extension] pickCopyDestination (${gesture}): ${detail}`);
    void vscode.window.showErrorMessage(`Modbench: Could not look up destination plugins: ${detail}`);
    return undefined;
  }
}

/** #436/#494: the shared body behind both `modbench.record.copyAsOverride`/`copyAsNewRecord` —
 *  resolve which record was right-clicked and from where, pick a destination, call the matching
 *  `SessionController` method, toast on success. No confirmation modal (xEdit's own CopyInto asks
 *  nothing before an override copy, only before an EditorID-changing copy-as-new — and Copy as New
 *  Record here prompts for neither an EditorID nor a FormKey, the same "land immediately, rename
 *  via the grid afterward" posture `record.create` already established for a blank creation). */
async function runCopyRecordCommand(
  gesture: CopyGesture, arg: RecordNode | ColumnHeaderContext | undefined,
  controller: SessionController, repository: PluginRepository,
  resolveOriginOrReport: (node: { origin?: string; pluginName: string }) => Promise<string | undefined>,
  outputChannel: vscode.LogOutputChannel,
): Promise<void> {
  const identity = recordCopyIdentity(arg);
  if (!identity) return;
  const sourceOrigin = await resolveOriginOrReport({ origin: identity.origin, pluginName: identity.plugin });
  if (!sourceOrigin) return;

  const destination = await pickCopyDestination(repository, gesture, identity.formKey, outputChannel);
  if (!destination) return;

  if (gesture === 'copy-as-override') {
    const ok = await controller.copyRecordAsOverride(identity.formKey, identity.plugin, sourceOrigin, destination.name, destination.origin);
    if (ok) void vscode.window.showInformationMessage(`Modbench: Copied ${identity.formKey} into ${destination.name}.`);
  } else {
    const newFormKey = await controller.copyRecordAsNewRecord(
      identity.formKey, identity.plugin, sourceOrigin, destination.name, destination.origin,
    );
    if (newFormKey) void vscode.window.showInformationMessage(`Modbench: Copied as ${newFormKey} into ${destination.name}.`);
  }
}

/** #432: the poller has no backend to answer it until Launch mEdit's spawn succeeds — gated on
 *  BackendManager's own 'status'/isHealthy signal (`gateExternalChangePolling`'s own doc comment),
 *  the same idiom `clearSessionWhenBackendDies` already reacts to. Pulled out of `activate()`
 *  purely for that function's own line budget. No disposable to register: a deliberate Close mEdit
 *  and this file's own deactivate() (backendManager.dispose()) both already emit 'stopped', which
 *  this reacts to like any other transition. */
function wireExternalChangePolling(
  repository: PluginRepository, controller: SessionController, outputChannel: vscode.LogOutputChannel, log: (msg: string) => void,
): void {
  gateExternalChangePolling({
    onBackendStatusChange: (cb) => backendManager!.on('status', cb),
    isBackendHealthy: () => backendManager!.isHealthy,
    startPolling: () => startExternalChangeDialogPolling(repository, controller, outputChannel, log),
  });
}

/** #417: polls `GET /plugins/external-changes/status` (fed by both the backend's live watcher and
 *  its load-time hash check) and runs the one dialog, sequentially, for whatever it finds — pulled
 *  out of `activate()` purely for that function's own line budget. Returns the stop function. */
function startExternalChangeDialogPolling(
  repository: PluginRepository, controller: SessionController, outputChannel: vscode.LogOutputChannel, log: (msg: string) => void,
): () => void {
  return startExternalChangePolling({
    repository,
    controller,
    showDialog: (message, options, ...buttons) => Promise.resolve(vscode.window.showWarningMessage(message, options, ...buttons)),
    showRebaseOffer: (message, ...buttons) => Promise.resolve(vscode.window.showInformationMessage(message, ...buttons)),
    openMergeEditor: makeMergeEditorOpener(repository, outputChannel),
    log,
  });
}

/** #381: composes the loud crash-repair offer sequence over Save & Compile's existing tail
 *  (`compileAndReport`) — pulled out of `activate()` purely for that function's own line budget,
 *  same reason `startExternalChangeDialogPolling` above was. Run once per completed session load
 *  (`makeEnterEditing`'s own call site), never a poller: see `crashRepairOffer.ts`'s own doc
 *  comment for why a session load is the only moment either offer reason can newly arise. */
function makeCrashRepairOffersPresenter(
  controller: SessionController, diagnostics: vscode.DiagnosticCollection,
): (offers: CrashRepairOffer[]) => Promise<void> {
  return (offers) => presentCrashRepairOffers(
    offers,
    (message, options, ...buttons) => Promise.resolve(vscode.window.showWarningMessage(message, options, ...buttons)),
    (offer, atRef) => compileAndReport(controller, diagnostics, { name: offer.plugin, origin: offer.origin }, atRef),
  );
}

/** #417: `Modbench: Rebase onto Updated Baseline` — origin-scoped (the repo, not any one plugin,
 *  is the unit of baselines and rebase), resolved from a tracked plugin row the same way Track
 *  resolves origin. Also the *re-runnable* form: {@link SourceRepository.RebaseEditBranch}'s own
 *  resumption-aware design means this same command both starts a rebase and resumes one left
 *  conflicted after the user resolves it in the native merge editor. */
function registerRebaseCommand(
  controller: SessionController, repository: PluginRepository, outputChannel: vscode.LogOutputChannel,
): vscode.Disposable {
  return vscode.commands.registerCommand('modbench.pluginListTree.rebase', async (node?: PluginListNode) => {
    if (node?.kind !== 'plugin') return;
    const name = node.plugin.name;
    const origin = await controller.resolveOrigin(name);
    if (!origin) {
      outputChannel.error(`[extension] rebase could not resolve an origin for "${name}"`);
      void vscode.window.showErrorMessage(`Modbench: Could not resolve which mod "${name}" belongs to.`);
      return;
    }

    const result = await runRebase({ controller, openMergeEditor: makeMergeEditorOpener(repository, outputChannel) }, origin);
    if (!result) return; // transport failure already surfaced by SessionController

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

/** The {@link OpenMergeEditor} every rebase caller shares — resolves `origin`'s mod folder from any
 *  plugin already known to share it, then opens the conflicted path inside it. VS Code's built-in
 *  git extension shows its own 3-way merge editor for a file it recognizes as conflicted in a
 *  tracked repo (confirmed against the local vscode-docs clone's 1.70 release notes: "The merge
 *  editor can be opened by clicking on a conflicting file in the Source Control view" — `vscode.
 *  open` is that same gesture, scripted). Resolved fresh per call rather than pre-bound to one
 *  origin: the dialog-driven path (unlike the standalone command) has no single already-resolved
 *  origin in scope, since more than one repo can be mid-answer at once. */
function makeMergeEditorOpener(repository: PluginRepository, outputChannel: vscode.LogOutputChannel): OpenMergeEditor {
  return async (origin, relativePath) => {
    const plugins = await repository.getPlugins();
    const anyPluginPath = plugins.find((p) => p.origin === origin)?.path;
    const modFolder = anyPluginPath ? path.dirname(anyPluginPath) : undefined;
    if (!modFolder) {
      outputChannel.error(`[extension] openMergeEditor: could not resolve "${origin}"'s mod folder`);
      return;
    }
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path.join(modFolder, relativePath)));
  };
}

/** #416: Save & Compile — reachable from a tracked plugin row's context menu (`node` given), the
 *  record editor's title-bar icon (compiles the *active* record's owning plugin — #416 review: this
 *  used to fall straight through to an unfiltered QuickPick, risking compiling the wrong plugin in a
 *  multi-mod session), and the command palette (QuickPick fallback only when neither a tree row nor
 *  an active record is in hand — see `resolveCompileTarget` in `./medit/compileTarget` for the exact
 *  order). */
/** Builds the `git:` scheme URI VS Code's own built-in git extension resolves a file's content at
 *  an arbitrary ref through — the stable, documented convention (`{path, ref}` JSON in the query)
 *  used by many extensions without importing the git extension's own types, the same "structural,
 *  not a dependency" posture this file already takes with `openRepository` (`trackedRepositories.ts`).
 *  Requires the file's own repo to already be registered with `vscode.git` — true for every tracked
 *  mod folder here (`registerTrackedRepositories`, called at the same session-load hand-off this
 *  command's own target reads its plugin list from). */
function gitRefUri(fsPath: string, ref: string): vscode.Uri {
  return vscode.Uri.file(fsPath).with({ scheme: 'git', query: JSON.stringify({ path: fsPath, ref }) });
}

/** #448 AC4: "Diff against source" — the Stack node's binary entry opens a native diff of the
 *  working tree against `refs/medit/last-compile/<plugin>` (`SourceRepository`'s own parked
 *  snapshot, `MEditService.Core/Source/SourceRepository.cs` — "Save & Compile" in CONTEXT.md).
 *  Pure git/VS Code: no backend call, matching "commit/revert stay in the native SCM panel" — the
 *  maintainer's own "map + links, not duplicated function" decision for this entry.
 *
 *  Scoped to the plugin's own root source file (`source/<plugin>/RecordData.json`) — CONTEXT.md's
 *  "one *source unit* = one file" invariant guarantees this file always exists for a tracked
 *  plugin, holding the mod header's own fields — rather than every file the compile touched. A
 *  plugin with group-folder content (records under `Weapons/`, `Cells/`, …) can have changes this
 *  diff does not show; a whole-tree multi-file diff is `vscode.changes` (VS Code 1.94+, unlike this
 *  extension's current `^1.85.0` floor) and is a natural follow-up once that floor decision is
 *  made, not built here. */
function registerDiffAgainstSourceCommand(
  repository: PluginRepository, outputChannel: vscode.LogOutputChannel,
): vscode.Disposable {
  return vscode.commands.registerCommand('modbench.pluginListTree.diffAgainstSource', async (node?: StackBinaryStateNode) => {
    if (!(node instanceof StackBinaryStateNode)) return;
    const { plugin, origin } = node;
    try {
      const plugins = await repository.getPlugins();
      const winner = plugins.find((p) => p.name === plugin && p.origin === origin);
      if (!winner) {
        outputChannel.error(`[extension] diffAgainstSource: "${plugin}" (${origin}) is not in the current session`);
        void vscode.window.showErrorMessage(`Modbench: "${plugin}" is not in the current session.`);
        return;
      }
      const sourceRoot = path.join(path.dirname(winner.path), 'source', plugin, 'RecordData.json');
      if (!fs.existsSync(sourceRoot)) {
        outputChannel.error(`[extension] diffAgainstSource: no source file at "${sourceRoot}"`);
        void vscode.window.showErrorMessage(`Modbench: "${plugin}" has no tracked source to diff.`);
        return;
      }
      const ref = `refs/medit/last-compile/${plugin}`;
      await vscode.commands.executeCommand(
        'vscode.diff', gitRefUri(sourceRoot, ref), vscode.Uri.file(sourceRoot), `${plugin} (last compile ↔ working tree)`,
      );
    } catch (err) {
      // ADR-0026: an explicit user action failed — notify + log, never a silent no-op. Covers
      // both a transport failure and the ref not existing yet (never compiled) — the git content
      // provider reports that as a rejection, not a distinguishable error code, so both read the
      // same to the user: nothing to diff against yet.
      const message = err instanceof Error ? err.message : String(err);
      outputChannel.error(`[extension] diffAgainstSource("${plugin}") failed: ${message}`);
      void vscode.window.showErrorMessage(`Modbench: Could not diff "${plugin}" against its last compile — has it been compiled yet?`);
    }
  });
}

function registerSaveAndCompileCommand(
  controller: SessionController,
  repository: PluginRepository,
  activeRecordTracker: ActiveRecordTracker<vscode.WebviewPanel>,
  outputChannel: vscode.LogOutputChannel,
  diagnostics: vscode.DiagnosticCollection,
): vscode.Disposable {
  return vscode.commands.registerCommand('modbench.saveAndCompile', async (node?: PluginListNode | StackBinaryStateNode) => {
    // #448: the Stack node's own binary entry already carries its exact (plugin, origin) — no
    // resolveCompileTarget round trip needed, the same reason a plugin row's own name is tier 1
    // there instead of falling through to the active-record/QuickPick tiers.
    if (node instanceof StackBinaryStateNode) {
      await compileAndReport(controller, diagnostics, { name: node.plugin, origin: node.origin }, undefined);
      return;
    }
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

    await compileAndReport(controller, diagnostics, target, undefined);
  });
}

/** #416 S13: compiling at `main` (no checkout — the edit branch and its dirt are untouched) writes
 *  the binary as `main` has it, behind one confirmation that names the ref literally, never
 *  "pristine" (no stored mode, ADR-0041 amendment) — a Modified workflow's pristine restore and an
 *  Authored workflow's release rebuild are the same gesture, and neither is this command's business
 *  to tell apart. Tree-row only (unlike Save & Compile itself): naming a ref to compile at from the
 *  palette with no plugin in hand isn't a gesture worth a QuickPick, so `pickPlugin` here is a no-op
 *  (`resolveCompileTarget`'s third tier never fires without a tree row). */
function registerCompileAtRefCommand(
  controller: SessionController, outputChannel: vscode.LogOutputChannel, diagnostics: vscode.DiagnosticCollection,
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

    await compileAndReport(controller, diagnostics, target, 'main');
  });
}

function reportCompileTargetError(outputChannel: vscode.LogOutputChannel, command: string, message: string): void {
  outputChannel.error(`[extension] ${command}: ${message}`);
  void vscode.window.showErrorMessage(`Modbench: ${message}`);
}

/** The shared tail both compile commands share once they have a target: call through
 *  `SessionController.compile`, publish diagnostics, and report the one of two outcomes
 *  (`CompileResult.succeeded`) the user got. `SessionController.compile` already surfaces a
 *  transport/HTTP failure itself (`null`), so this has nothing to report in that case. */
async function compileAndReport(
  controller: SessionController, diagnostics: vscode.DiagnosticCollection,
  target: CompileTarget, atRef: string | undefined,
): Promise<void> {
  const result = await controller.compile(target.name, target.origin, atRef);
  if (!result) return;

  publishCompileDiagnostics(diagnostics, target.origin, result);

  const refSuffix = atRef ? ` at "${atRef}"` : '';
  if (!result.succeeded) {
    void vscode.window.showErrorMessage(`Modbench: Could not compile "${target.name}"${refSuffix} — ${result.refusalReason}`);
    return;
  }
  void vscode.window.showInformationMessage(
    result.diagnostics.length > 0
      ? `Modbench: Compiled "${target.name}"${refSuffix} — ${result.diagnostics.length} diagnostic(s), see Problems panel.`
      : `Modbench: Compiled "${target.name}"${refSuffix}.`,
  );
}

/** Publishes one compile's diagnostics to the Problems panel, replacing whatever this plugin's
 *  source files held from its last compile — never additive, or a fixed diagnostic would survive
 *  forever once its record stopped reappearing in a later compile's own report. Grouped by source
 *  file (one `Uri` can carry several diagnostics) since `CompileDiagnostic` names its record's
 *  field, not a line/column this text format doesn't define. */
function publishCompileDiagnostics(collection: vscode.DiagnosticCollection, origin: string, result: CompileResult): void {
  const instanceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!instanceRoot) return;
  const modFolder = path.join(instanceRoot, 'mods', origin);

  // Clear every URI this collection previously held for this mod folder before republishing —
  // DiagnosticCollection has no "clear just this prefix" primitive, so the set is tracked here.
  for (const [uri] of collection) {
    if (uri.fsPath.startsWith(modFolder + path.sep)) collection.delete(uri);
  }

  const byUri = new Map<string, vscode.Diagnostic[]>();
  for (const d of result.diagnostics) {
    const fsPath = path.join(modFolder, d.sourceRelativePath);
    const list = byUri.get(fsPath) ?? [];
    list.push(new vscode.Diagnostic(new vscode.Range(0, 0, 0, 0), d.message, vscode.DiagnosticSeverity.Warning));
    byUri.set(fsPath, list);
  }
  for (const [fsPath, list] of byUri) collection.set(vscode.Uri.file(fsPath), list);
}

/** #279 / #356 / ADR-0035 § Live mutation: origin drift is the comparison
 *  between the origin a plugin's records were read from and the origin its name resolves to now,
 *  absorbed automatically when the two disagree. The tracker owns both the comparison and the
 *  reaction, and imports from neither bounded context; this is where both halves are injected —
 *  Mod Management's (`currentOrigins`) and Editing's (`reread`) — which is the only place allowed
 *  to know both sides.
 *
 *  The walk is done fresh per refresh rather than against a cached index: it runs off a debounced
 *  watcher, and the whole question it answers is "what does the loadout say *now*". */
function makeDriftTracker(
  modlistSource: Mo2ModlistSource,
  instanceRoot: string,
  outputChannel: vscode.LogOutputChannel,
  gameDirResolver: GameDirectoryResolver,
  controller: SessionController,
): DriftTracker {
  return createDriftTracker({
    log: (msg) => outputChannel.debug(msg),
    currentOrigins: async (names) => resolveCurrentPluginOrigins(
      names,
      await buildFileConflictIndex(await modlistSource.readModlist(), instanceRoot, (msg) => outputChannel.debug(msg)),
      instanceRoot,
      // #357: read through the single game-directory resolver every other consumer (views,
      // session launch, deploy) shares — memoised and invalidated only when
      // modbench.mods.gameDirectory changes, so this always agrees with what the session actually
      // loaded even though the setting is editable while Modbench runs.
      (await gameDirResolver.resolve())?.dataFolder,
    ),
    reread: (plugin, path, origin) => controller.rereadPlugin(plugin, path, origin),
  });
}

/** #352: modbench.sessionRunning drives the Launch mEdit / Close mEdit toggle on the Plugins
 *  view's title bar — the same two-command/context-key toggle shape as sort direction and
 *  show-hidden, just contributed to overflow instead of a navigation icon slot. Explicit
 *  initial value, not left implicitly falsy, matching modbench.workspaceIsMo2Instance's own
 *  "every exit path sets it" convention. Every backend lifecycle transition — attach,
 *  disconnect, crash, and a deliberate stop — moves it, the same set of transitions
 *  clearSessionWhenBackendDies below reacts to. */
function wireSessionRunningContext(manager: BackendManager): void {
  void vscode.commands.executeCommand('setContext', 'modbench.sessionRunning', false);
  manager.on('status', () => {
    void vscode.commands.executeCommand('setContext', 'modbench.sessionRunning', manager.isHealthy);
  });
}

/** A backend that dies takes the session with it, and `exitToLoadout` is not on that path — a
 *  crash or a lost connection reaches us only as a status change. Without this the rows keep their
 *  chevrons and expanding one fetches against a backend that is gone (#270), the record rows keep
 *  a read-only set nothing backs (#281), and the drift markers keep describing a session that no
 *  longer exists (#279). All three are statements about a live session, so all three go together. */
function clearSessionWhenBackendDies(
  composite: PluginsTreeComposite<PluginListNode, PluginTreeNode>,
  recordBrowser: PluginTreeProvider,
  tracker: DriftTracker,
): void {
  backendManager?.on('status', () => {
    if (backendManager?.isHealthy) return;
    composite.setSession(undefined);
    recordBrowser.setImmutablePlugins([]);
    // #448: same reasoning as setImmutablePlugins above — a dead session's Stack-node state
    // entries must not survive it.
    recordBrowser.setTrackedPlugins([]);
    recordBrowser.setPluginOrigins(new Map());
    // #364: same reasoning again — a dead session's Conflicts node and badge must not survive it.
    recordBrowser.setConflictsComputed(false);
    tracker.setLoaded(undefined);
    // #278 / ADR-0035 amending ADR-0018: same reasoning as the three above — a statement about
    // which plugins the dead session's records matched must not seed the next one.
    matchingPlugins = undefined;
  });
}

/** #279 / #356: what keeps the drift tracker current — Mod Management's own reactive watchers,
 *  never a timer (modbench/CLAUDE.md: reactive over manual, and this ticket adds no polling). Each
 *  `refresh()` now absorbs what it finds (re-reading a plugin whose origin changed) as well as
 *  detecting it, so these two watchers are the whole of the automatic-absorption wiring — there is
 *  no separate render step, and no command, downstream of them any more.
 *
 *  Two watchers because one does not cover the three gestures. `modlist.txt` is rewritten by
 *  install, uninstall *and* reprioritise, so it catches all three; `mods/**` catches a folder
 *  appearing or vanishing without a `modlist.txt` write, which is what a hand-dropped or
 *  hand-deleted mod folder looks like before auto-registration notices it. */
function wireDriftTracker(tracker: DriftTracker, instanceRoot: string): vscode.Disposable[] {
  return [
    tracker,
    createModlistWatcher(instanceRoot, () => void tracker.refresh()),
    createModsWatcher(instanceRoot, () => void tracker.refresh()),
  ];
}

/** #255: the merged Plugins tree's name filter — the axis that narrows *which plugin rows*
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

/** Overwrite-folder surface (#82): a live watcher that re-renders the Mods tree
 *  as `overwrite/` fills/empties (reactive over manual refresh), plus the sole
 *  action — reveal the folder in the Explorer (single-click reuses this too). */
function registerOverwriteView(
  instanceRoot: string,
  modListProvider: ModListProvider,
  outputChannel: vscode.LogOutputChannel,
): vscode.Disposable[] {
  return [
    createOverwriteWatcher(instanceRoot, () => modListProvider.invalidate()),
    // Tint the pinned Overwrite row reddish (#83). Stateless: keyed on the
    // constant overwrite/ path, which matches OverwriteNode.resourceUri.
    vscode.window.registerFileDecorationProvider(new OverwriteDecorationProvider(instanceRoot)),
    vscode.commands.registerCommand('modbench.modList.overwrite.reveal', async (node: OverwriteNode) => {
      if (node?.kind !== 'overwrite') return;
      try {
        await vscode.commands.executeCommand('revealInExplorer', node.resourceUri);
      } catch (err) {
        outputChannel.error(`[extension] revealInExplorer for overwrite/ failed: ${err instanceof Error ? err.message : String(err)}`);
        void vscode.window.showErrorMessage('Modbench: Failed to reveal the overwrite folder in the Explorer.');
      }
    }),
  ];
}

/** Auto-registration (#81): a live watcher that adds a modlist.txt entry for
 *  any mods/<name>/ folder that appears while Modbench is running (dragged
 *  into Explorer, extracted by hand, or installed some other way outside
 *  Modbench) — reactive over manual, same as the overwrite/ watcher above. */
function registerModsAutoRegisterWatcher(
  instanceRoot: string,
  modlistSource: Mo2ModlistSource,
  modListProvider: ModListProvider,
  outputChannel: vscode.LogOutputChannel,
): vscode.Disposable {
  return createModsWatcher(instanceRoot, () => {
    modlistSource
      .registerUnlistedMods()
      .then((added) => {
        if (added.length > 0) modListProvider.invalidate();
      })
      .catch((err: unknown) => {
        outputChannel.error(`[extension] auto-registering mods/ folders failed: ${err instanceof Error ? err.message : String(err)}`);
      });
  });
}

/** #192: the workspace is open but isn't an MO2 instance (ModOrganizer.ini,
 *  mods/, profiles/ absent). Don't build a provider that would only fail
 *  lazily on first read — register the Mods view with an always-empty stub so
 *  its native `viewsWelcome` contribution (gated on
 *  `modbench.workspaceIsMo2Instance`) renders an actionable message instead
 *  of an error tree node. */
function registerNotMo2InstanceWelcome(
  instanceRoot: string,
  context: vscode.ExtensionContext,
  outputChannel: vscode.LogOutputChannel,
): void {
  outputChannel.info(`[extension] Workspace "${instanceRoot}" is not an MO2 instance — showing welcome content instead of the Mods tree.`);
  void vscode.commands.executeCommand('setContext', 'modbench.workspaceIsMo2Instance', false);
  context.subscriptions.push(
    vscode.window.createTreeView('modbench.modList', { treeDataProvider: NOT_MO2_INSTANCE_PROVIDER }),
  );
}

/** Enable/disable a mod from its row checkbox. ADR-0026: a failed toggle must surface, not
 *  silently leave the checkbox out of sync with disk — log detail, notify, and invalidate so
 *  the checkbox resyncs to what `modlist.txt` actually says. */
async function onModCheckboxChanged(
  e: vscode.TreeCheckboxChangeEvent<ModlistNode>,
  modListProvider: ModListProvider,
  outputChannel: vscode.LogOutputChannel,
): Promise<void> {
  for (const [node, state] of e.items) {
    if (node.kind !== 'mod') continue;
    try {
      await modListProvider.setModEnabled(node.mod.name, state === vscode.TreeItemCheckboxState.Checked);
    } catch (err) {
      outputChannel.error(`[extension] toggling "${node.mod.name}" failed: ${err instanceof Error ? err.message : String(err)}`);
      void vscode.window.showErrorMessage(`Modbench: Failed to update "${node.mod.name}".`);
      modListProvider.invalidate();
    }
  }
}

/** The Loadout half of activation, as one step: deployment-mode context key, the
 *  Mods/Plugins/Downloads views, and the header that sits above them. Split out of `activate`
 *  because these three are one wiring concern — and because the header must register even on
 *  the paths where `registerLoadoutView` bails (no workspace, or not an MO2 instance): it is
 *  the container's first view and must never be a hole. Returns what the integration tests
 *  read off `activate`'s exports. */
function registerLoadoutSurfaces(deps: Omit<LoadoutViewDeps, 'revealLog'>): {
  modListProvider?: ModListProvider; downloadsProvider?: DownloadsProvider; pluginListProvider?: PluginListProvider;
  // #288: forwarded so the composition root can wire modbench.newPlugin's destination QuickPick —
  // both are undefined together with the providers above, on the same no-workspace/not-an-MO2-
  // instance paths registerLoadoutView already bails on.
  modlistSource?: Mo2ModlistSource; instanceRoot?: string;
} {
  const { context, outputChannel } = deps;
  registerDeploymentModeContext(context);
  const loadout = registerLoadoutView({ ...deps, revealLog: () => outputChannel.show(true) });
  registerLoadoutHeaderView({ context, outputChannel, ...loadout });
  return {
    modListProvider: loadout?.modListProvider,
    downloadsProvider: loadout?.downloadsProvider,
    pluginListProvider: loadout?.pluginListProvider,
    modlistSource: loadout?.modlistSource,
    instanceRoot: loadout?.instanceRoot,
  };
}

/** The Mods tree, its name filter, and the profile readout — together, because #255 made them
 *  one thing: the view's description is written by exactly one owner (the filter), and the
 *  active profile is what it composes the term around. Split apart, the profile update and a
 *  filter keystroke would race for the same property and the loser would silently vanish. */
function createModListView(
  modListProvider: ModListProvider,
  modlistSource: Mo2ModlistSource,
  outputChannel: vscode.LogOutputChannel,
): {
  modListView: vscode.TreeView<ModlistNode>; modListFilter: NameFilter; updateProfileDescription: () => Promise<void>;
  revealInModsTreeCommand: vscode.Disposable;
} {
  const modListView = vscode.window.createTreeView('modbench.modList', {
    treeDataProvider: modListProvider,
    showCollapseAll: true,
    dragAndDropController: modListProvider,
  });
  const modListFilter = registerNameFilter({
    view: modListView,
    viewId: 'modbench.modList',
    placeholder: 'Filter mods…',
    setFilter: (text, grouping) => modListProvider.setFilter(text, grouping),
    // The pinned Overwrite row sits outside all filtering (it is a fixture over the folder, not
    // a modlist entry), so it is not evidence that the term matched anything.
    hasRows: async () => (await modListProvider.getChildren()).some((n) => !(n instanceof OverwriteNode)),
    toggle: { icon: 'list-tree', label: 'Group by separator' },
  });
  const updateProfileDescription = async () => {
    try {
      modListFilter.setBaseDescription(await modlistSource.getActiveProfile());
    } catch (err) {
      outputChannel.error(`[extension] reading active profile failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  void updateProfileDescription();
  // #448 AC5: built here (not registerLoadoutView, which the addition pushed over the lint
  // budget) since it needs exactly the modListView this function already constructs.
  const revealInModsTreeCommand = registerRevealInModsTreeCommand(modListProvider, modListView, outputChannel);
  return { modListView, modListFilter, updateProfileDescription, revealInModsTreeCommand };
}

interface LoadoutViewDeps {
  context: vscode.ExtensionContext;
  log: (msg: string) => void;
  outputChannel: vscode.LogOutputChannel;
  revealLog: () => void;
  controller: SessionController;
  /** #270: the record browser the Plugins tree's rows expand into. Threaded from `activate`,
   *  which owns the single instance both plugin trees read through. */
  recordBrowser: PluginTreeProvider;
  /** #270: the plugin files the running session holds, for deciding which rows can expand.
   *  Injected as a getter so the composite's own wiring stays at the composition root. */
  sessionPluginFiles: () => Promise<SessionPluginFiles>;
  /** #381: run the loud crash-repair offer sequence for whatever a completed session load found.
   *  Composed once at the composition root (activate()), where the diagnostics collection and
   *  compileAndReport's own compile door already live. */
  showCrashRepairOffers: (offers: CrashRepairOffer[]) => Promise<void>;
}
/** Register the Loadout (Mod List) view and its commands. Returns the live
 *  ModListProvider and DownloadsProvider (exposed via activate() for integration
 *  tests), or undefined with a neutral log when no workspace is open, or when the
 *  workspace isn't an MO2 instance (#192 — the Mods view shows welcome content instead). */
function registerLoadoutView(deps: LoadoutViewDeps): { modListProvider: ModListProvider; downloadsProvider: DownloadsProvider; pluginListProvider: PluginListProvider; modlistSource: Mo2ModlistSource; instanceRoot: string; refreshAll: () => void } | undefined {
  const { context, log, outputChannel, revealLog, controller, recordBrowser, sessionPluginFiles, showCrashRepairOffers } = deps;
  const instanceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!instanceRoot) {
    outputChannel.info('[extension] No workspace folder open — Mod List view not registered.');
    // #192: explicit, not left implicitly falsy — the viewsWelcome `when` clause
    // also guards on VS Code's own `workspaceFolderCount != 0`, so this key's
    // value never actually matters with no workspace open, but every exit path
    // sets it rather than leaving a third, implicit "never set" state.
    void vscode.commands.executeCommand('setContext', 'modbench.workspaceIsMo2Instance', false);
    return undefined;
  }
  // #192: an MO2 instance is the folder containing ModOrganizer.ini, mods/, and
  // profiles/ — distinct from a real instance with a genuinely unreadable/corrupt
  // modlist, which still reports as an error tree node (ADR-0026).
  if (!isMo2Instance(instanceRoot)) {
    registerNotMo2InstanceWelcome(instanceRoot, context, outputChannel);
    return undefined;
  }
  void vscode.commands.executeCommand('setContext', 'modbench.workspaceIsMo2Instance', true);
    const modListReporter = makeReporter(outputChannel, 'modList');
    const modlistSource = new Mo2ModlistSource(instanceRoot, log, modListReporter);
    // #357: the single GameDirectory resolver (config override → ini gamePath → autodetect),
    // memoised and invalidated only when modbench.mods.gameDirectory changes — the one thing every
    // consumer of the game directory (these views, the drift tracker, session launch, deploy)
    // reads through, so none of them can disagree about which folder is current. Replaces the old
    // activation-scoped `dataFolder: Promise<string | undefined>`, which was resolved once here and
    // then frozen for the life of the window regardless of later edits to the setting.
    const gameDirResolver = createGameDirectoryResolver(instanceRoot, meditConfig, makeDetectPaths(), detectWinePrefix, vscode.workspace.onDidChangeConfiguration);
    // Non-blocking (keeps registration synchronous) and never rejects — a null resolution or a
    // misconfigured explicit setting both fold to undefined, so the consumers degrade exactly as
    // before (empty vanilla masters, badges absent). A rejection is re-thrown by every other
    // consumer of `gameDirResolver` directly; only the views degrade to undefined.
    // #357 AC5: `dataFolderFrom` memoises the fold (and its error log) by the resolver's own cache
    // generation, so a stuck-broken setting logs once — `ImplicitMasterDecorationProvider` alone
    // reads this once per visible file, and a naive `.then()/.catch()` per call would re-log on
    // every one of those reads instead of once for the life of the resolution.
    const dataFolder = dataFolderFrom(gameDirResolver, (e) =>
      outputChannel.error(`[extension] resolving the game directory failed: ${e instanceof Error ? e.message : String(e)}`));
    const modListProvider = new ModListProvider({ source: modlistSource, log, instanceRoot, reporter: modListReporter, dataFolder });
    const { pluginListProvider, disposables: pluginListDisposables } =
      registerPluginListView({ modlistSource, log, outputChannel, reporter: makeReporter(outputChannel, 'pluginList'), instanceRoot, dataFolder, gameDirResolver, recordBrowser, controller });
    const { modListView, modListFilter, updateProfileDescription, revealInModsTreeCommand } =
      createModListView(modListProvider, modlistSource, outputChannel);
    const { runModAction, promptModName, warnIfFomod } = makeModActionHelpers(modListProvider, outputChannel);
    const enterEditing = makeEnterEditing({
      instanceRoot, modlistSource, controller, outputChannel, revealLog, sessionPluginFiles, showCrashRepairOffers, gameDirResolver,
    });
    // #295: the one assignment — see the module-level declaration's comment for why this can't
    // be threaded as a parameter instead.
    enterEditingFn = enterEditing;

    backendManager!.on('restarted', () => {
      void enterEditing().catch((err: unknown) =>
        outputChannel.error(`[extension] reload after backend restart failed: ${err instanceof Error ? err.message : String(err)}`),
      );
    });

    context.subscriptions.push(
      modListView,
      modListFilter,
      modListView.onDidChangeCheckboxState((e) => onModCheckboxChanged(e, modListProvider, outputChannel)),
      ...registerModListCoreCommands({ modListProvider, modlistSource, updateProfileDescription, enterEditing, outputChannel }),
      ...registerDeployCommands(instanceRoot, modlistSource, outputChannel, gameDirResolver),
      registerLaunchCommand(outputChannel),
      gameDirResolver,
      ...registerModInstallCommands({ modlistSource, runModAction, promptModName, warnIfFomod }),
      ...registerModContextCommands({ instanceRoot, modlistSource, outputChannel, runModAction }),
      ...registerSeparatorCommands({ modlistSource, runModAction }),
      ...registerOverwriteView(instanceRoot, modListProvider, outputChannel),
      registerModsAutoRegisterWatcher(instanceRoot, modlistSource, modListProvider, outputChannel),
      ...pluginListDisposables,
      revealInModsTreeCommand,
    );

    const { downloadsProvider, disposables: downloadsDisposables } = registerDownloadsView(instanceRoot, log);
    context.subscriptions.push(...downloadsDisposables);
    const refreshAll = makeRefreshAll(modListProvider, pluginListProvider, downloadsProvider, updateProfileDescription);
    return { modListProvider, downloadsProvider, pluginListProvider, modlistSource, instanceRoot, refreshAll };
}

/** #247: Refresh is one need, not three. Every Mod-Management source re-reads from disk
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
/** #247: the Loadout header view — workspace-scope readout and action home. Wired here, at
 *  the composition root, because it spans both bounded contexts; the provider itself takes
 *  only getters and knows about neither. */
function registerLoadoutHeaderView(deps: LoadoutHeaderDepsWiring): void {
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
  loadoutHeaderProvider = provider;
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
  // #352: the header's rows (profile, deployment) no longer read backend/session state — the
  // mEdit row moved to the Plugins view — so there is nothing here left for a backend status
  // transition to invalidate.
}

/** Downloads sidebar tree (#233): a native TreeView over downloads/, replacing the editor-tab
 *  webview. The row's native `view/item/context` menu commands are registered here too — see
 *  DownloadsPanel.ts' registerDownloadsSingleRowCommands/registerDownloadsMultiRowCommands and
 *  package.json's contributes.menus["view/item/context"]. Returns the live provider (exposed
 *  via activate() for integration tests) alongside its disposables. */
function registerDownloadsView(
  instanceRoot: string,
  log: (msg: string) => void,
): { downloadsProvider: DownloadsProvider; disposables: vscode.Disposable[] } {
  const downloadsProvider = new DownloadsProvider(instanceRoot, log);
  const downloadsView = vscode.window.createTreeView('modbench.downloads', {
    treeDataProvider: downloadsProvider,
    canSelectMany: true,
  });
  return {
    downloadsProvider,
    disposables: [
      downloadsView,
      createDownloadsWatcher(instanceRoot, () => downloadsProvider.invalidate()),
      // Dims hidden rows once Show hidden is on (#238) — the sole cue distinguishing them,
      // since Show hidden is additive, not an exclusive filter.
      vscode.window.registerFileDecorationProvider(
        new HiddenDownloadDecorationProvider(instanceRoot, () => downloadsProvider.hiddenNames()),
      ),
      registerNameFilter({
        view: downloadsView, viewId: 'modbench.downloads', placeholder: 'Filter downloads…',
        setFilter: (text) => downloadsProvider.setFilter(text),
        hasRows: async () => (await downloadsProvider.getChildren()).length > 0,
      }),
      registerDownloadsSortCommand(downloadsProvider),
      ...registerDownloadsHiddenToggleCommands(downloadsProvider),
      ...registerDownloadsSingleRowCommands(instanceRoot, log),
      ...registerDownloadsMultiRowCommands(instanceRoot, log),
    ],
  };
}

/** The completed load's whole hand-off to the tree: which plugins the session holds, which are
 *  read-only for editing (#276), each one's master issues (#277) and each one's load failure.
 *
 *  #270 / ADR-0035: rows gain chevrons here — and, since #307, *finish* gaining them here. A
 *  progressive load's ticks carry only the indexed set and the failures, because read-only state
 *  and master issues are whole-session derivations a partial session cannot answer; this is the
 *  call that fills them in. **A tick must never be the last word** — if one were, both those
 *  decorations would silently vanish from a fully loaded tree.
 */
async function applyLoadedSessionToTree(
  sessionPluginFiles: () => Promise<SessionPluginFiles>,
  failures: { name?: string | null; reason?: string | null }[],
  outputChannel: vscode.LogOutputChannel,
  // #342: the backend's own reported plugin count (the last poll's `SessionStatus.totalPlugins`,
  // via `makeTreeProgressHandler`'s `lastTotalPlugins()`) — carried in only so this can be logged
  // next to what actually reached the tree, not because this function needs it for anything else.
  // Deliberately not `plugins.length` from the caller's own request list: that list is what the
  // frontend asked the backend to load, and omits the implicit masters the backend prepends, so
  // comparing against it would read every healthy load as short.
  totalPlugins: number,
): Promise<void> {
  try {
    const session = await sessionPluginFiles();
    // #342: this is the one line standing between a stuck-tail load and a diagnosable one — do
    // not remove it as logging noise. `totalPlugins` is the backend's own count; `failures` is
    // what the load already reported as unopenable or unindexable, so a plugin counted there is
    // accounted for, not missing. `session.files.size + failures.length` should land close to
    // `totalPlugins` for an ordinary load — a gap bigger than that, or a load that otherwise
    // reaches "editing session ready" with no line at all, is what points at this hand-off rather
    // than at something upstream (most likely the backend's own `GET /plugins`).
    outputChannel.info(
      `[extension] applying completed session to tree: ${session.files.size} indexed, ${failures.length} failed, of ${totalPlugins} planned`,
    );
    // #277 / ADR-0037 AC7: the same failures the toast inside loadExplicitSession already
    // consumed — held here (not re-derived, not a second endpoint) and handed to the tree
    // through the same setSession bundle as everything else the session reports.
    const loadFailures = new Map(failures.map((f) => [f.name ?? '?', f.reason ?? 'Unknown error'] as const));
    // #278 / ADR-0035 amending ADR-0018: set before setSession fires its re-render, so no row
    // renders off a match set stale from whatever session (if any) preceded this one — this is
    // the fix for a stale `matchingPlugins` surviving a session (re)load, `modbench.reloadSession`
    // included, since that command re-runs this exact hand-off (`makeEnterEditing`'s `enter()`).
    matchingPlugins = session.matches;
    pluginsTree?.setSession(session.files, session.readOnly, session.masterIssues, loadFailures);
    // #279: the loaded half of the drift comparison. Handed over at the same moment as everything
    // else the completed load reports, then computed once against the loadout as it stands — so a
    // mod change made *before* the session opened is already reflected, not only ones made after.
    driftTracker?.setLoaded(session.origins);
    void driftTracker?.refresh();
    // #281: the same read-only set, to the record rows — theirs is contextValue (Remove
    // hidden), the plugin rows' is the tooltip note (#276).
    recordBrowserProvider?.setImmutablePlugins(session.readOnly);
    // #448: the Stack node's own state-entry facts — tracked-ness (a filesystem check only the
    // composition root can make) and each plugin's own loaded origin (the same fact driftTracker
    // just consumed above), from the same GET /plugins answer everything else in this hand-off
    // already reads.
    recordBrowserProvider?.setTrackedPlugins(session.trackedPlugins);
    recordBrowserProvider?.setPluginOrigins(session.origins);
  } catch (err) {
    // Leaving every row a leaf is a safe *render*, but it is not an honest one: the session
    // did load, so the tree would be telling the user editing is unavailable when it is
    // available, with nothing on screen to say why. ADR-0026 integrity tier — notify, don't
    // just log.
    const message = err instanceof Error ? err.message : String(err);
    outputChannel.error(`[extension] reading the session's plugin list failed; plugin rows will not expand: ${message}`);
    void vscode.window.showWarningMessage(
      'Modbench: The editing session loaded, but its plugin list could not be read — plugin rows will not expand into records. Reload the session to retry.',
    );
  }
}

/** #307 AC7: arm this launch's cancellation, and the check every step past an await makes.
 *
 *  Armed **before the launch's first await**, not just before the load POST. A launch has two
 *  phases — bring the backend up and walk the mod tree, then load — and closing the session during
 *  the first one has to be honoured too: AC7 says "closing the session mid-load" with no
 *  qualification by phase, and a backend spawn plus a filesystem walk is a realistic window to
 *  land in. Armed late, `exitToLoadout`'s `abort()` found nothing to cancel, and the stale launch
 *  ran on past the close to meet the backend it had just stopped — reporting "Backend failed to
 *  start" for something the user deliberately did.
 *
 *  The controller is held locally as well as in `loadAbort`, because that module-level slot
 *  belongs to whichever load is newest; only the closure below names *this* launch's own
 *  cancellation. Every exit past one is silent and touches nothing — the close has already torn
 *  the view down, so there is nothing to report and nothing to reset. Both failure modes (the
 *  spurious toast, and repopulating a tree the user just cleared) come from continuing. */
function armLoadAbort(outputChannel: vscode.LogOutputChannel): { signal: AbortSignal; abandoned: () => boolean } {
  const abort = new AbortController();
  loadAbort = abort;
  return {
    signal: abort.signal,
    abandoned: () => {
      if (!abort.signal.aborted) return false;
      outputChannel.info('[extension] the editing session launch was abandoned before it loaded; leaving the closed view alone');
      return true;
    },
  };
}

/** #307: the progressive-load tick handler, wired to this extension's own surfaces. Whether a
 *  tick is worth applying is decided in `medit/sessionProgress.ts` and unit-tested there; this
 *  supplies the hand-off itself, the only part that needs VS Code types. The empty read-only and
 *  master-issue arguments mid-load are deliberate — see `makeLoadProgressHandler`.
 *
 *  #342: also remembers each tick's own `totalPlugins`. That is the backend's count (implicit
 *  masters included, since the backend prepends them before this is ever reported) — a different,
 *  larger number than the frontend's own pre-load request list (`plugins.length` in `enter()`
 *  below), which never includes them. `applyLoadedSessionToTree`'s completion log needs something
 *  to compare its own count against; a tick already carries the right number, and it does not
 *  change over the load, so the last one seen is as good as asking again. */
function makeTreeProgressHandler(): { onProgress: (status: SessionLoadProgress) => void; lastTotalPlugins: () => number } {
  let totalPlugins = 0;
  const applyTick = makeLoadProgressHandler({
    say,
    applySession: (indexedPlugins, failures) => pluginsTree?.setSession(
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

interface EnterEditingDeps {
  instanceRoot: string;
  modlistSource: Mo2ModlistSource;
  controller: SessionController;
  outputChannel: vscode.LogOutputChannel;
  /** #270: the plugin files the loaded session holds — read once the session is up, to decide
   *  which rows can expand. */
  sessionPluginFiles: () => Promise<SessionPluginFiles>;
  /** Surface the Modbench output channel so the user can watch the launch steps. */
  revealLog: () => void;
  /** #381: run once a load completes, for whatever crash-repair offers it reported. */
  showCrashRepairOffers: (offers: CrashRepairOffer[]) => Promise<void>;
  /** #357: the single game-directory resolver, shared with the views and the drift tracker —
   *  memoised and invalidated only when modbench.mods.gameDirectory changes, so a session launch
   *  always agrees with what they currently show. */
  gameDirResolver: GameDirectoryResolver;
}
/** Build the enter-editing action: spawn/attach the backend and load the active
 *  modlist as a load-explicit session, then reveal the editing view. Also the
 *  crash-restart reload path.
 *
 *  #307 / ADR-0035 AC2: owns its own progress indicator (`withPluginsViewProgress` — see there)
 *  rather than leaving each of its three callers to wrap it, and reports its steps through `say`.
 *  Takes no progress reporter as a result. */
function makeEnterEditing(deps: EnterEditingDeps): () => Promise<void> {
  const {
    instanceRoot, modlistSource, controller,
    outputChannel, revealLog, sessionPluginFiles, showCrashRepairOffers, gameDirResolver,
  } = deps;
  const enter = async (): Promise<void> => {
      const { signal, abandoned } = armLoadAbort(outputChannel);
      const treeProgress = makeTreeProgressHandler();
      revealLog(); // the load can take a while; let the user watch the step log
      const gd = await gameDirResolver.resolve();
      if (abandoned()) return;
      if (!gd) {
        exitToLoadout(); // don't strand the UI in an empty editing view
        void vscode.window.showErrorMessage(
          'Modbench: No game directory found. Set modbench.mods.gameDirectory to your Stock Game Folder or Steam install.',
        );
        return;
      }
      // Spawn/attach the backend and walk the mod tree concurrently — independent
      // work; the health gate is applied after they join.
      say('Starting backend…');
      outputChannel.info('[extension] entering editing: starting backend and building plugin list');
      const [, plugins] = await Promise.all([
        backendManager!.start(),
        buildExplicitPluginsWithOrigin(modlistSource, instanceRoot, gd.dataFolder, (entries, root) =>
          buildFileConflictIndex(entries, root, (msg) => outputChannel.debug(msg)),
        ),
      ]);
      // Before the health gate, deliberately: a close stops the backend, so an abandoned launch
      // would otherwise fail this check and report the stop it asked for as a startup failure.
      if (abandoned()) return;
      if (!backendManager!.isHealthy) {
        exitToLoadout(); // tear down the half-started backend and reset the view
        void vscode.window.showErrorMessage('Modbench: Backend failed to start — see the Modbench output for details.');
        return;
      }
      // load-explicit is one blocking call that indexes every plugin — the slow part. The polled
      // status takes over from here (treeProgress.onProgress above), naming real counts as they
      // land; this states the total for the window before the first poll answers.
      say(`Indexing ${plugins.length} plugins… Conflict information is not yet computed.`);
      outputChannel.info(`[extension] backend healthy; loading session (${plugins.length} plugins)`);
      const result = await controller.loadExplicitSession(
        plugins, gd.dataFolder, undefined, { onProgress: treeProgress.onProgress, signal });
      // #307 AC7: a load that was deliberately abandoned — superseded by a newer load, or
      // aborted because the user closed the session — leaves *silently*. Nothing to surface
      // (loadExplicitSession only logged it) and, the bug this fixes, nothing to tear down: the
      // newer load owns the session now, and exitToLoadout() here would stop its backend.
      if (result.outcome === 'abandoned') {
        outputChannel.info('[extension] the editing session load was abandoned; leaving the session that replaced it alone');
        return;
      }
      // #295 AC4: the load itself failed — loadExplicitSession already surfaced the error
      // (ADR-0026 "explicit action failed" tier). The backend's own SessionManager disposes the
      // previous session unconditionally before attempting the new one, so by this point there is
      // truly no session left, not a stale one — the same treatment the two failure returns above
      // give themselves. Reading its plugin list or syncing its filter would either throw against
      // a sessionless backend or silently render nothing, neither of which is "the tree honestly
      // says editing is unavailable".
      if (result.outcome === 'failed') {
        exitToLoadout();
        return;
      }
      await controller.syncFilterState();
      await applyLoadedSessionToTree(sessionPluginFiles, result.failures, outputChannel, treeProgress.lastTotalPlugins());
      // #381: the loud detect-and-offer, run once per load — after the tree has already settled,
      // awaited and sequential (one native modal at a time; see crashRepairOffer.ts's own doc
      // comment). Declining leaves the marker/missing binary exactly as it is; nothing here clears
      // it, so the offer re-appears at the next session load by construction.
      if (result.crashRepairOffers.length > 0) {
        outputChannel.info(`[extension] ${result.crashRepairOffers.length} crash-repair offer(s) to present`);
        await showCrashRepairOffers(result.crashRepairOffers);
      }
      outputChannel.info('[extension] editing session ready');
  };
  return () => withPluginsViewProgress(enter);
}


/** #431: undici's default Agent times out a fetch with no response bytes after ~300s
 *  (headersTimeout/bodyTimeout). The backend's blocking endpoints — POST /session/load-explicit
 *  chief among them — legitimately run for minutes on a large load order, and every such call
 *  already carries its own deliberate abort signal where one is wanted (#307 AC7), so nothing
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
 *  imported by the webview bundle (RecordSessionClient.ts), which has no `undici`/Node runtime.
 *
 *  #495: `input.signal` is part of that unpacking too, deliberately — it is the *other* half of
 *  the "own deliberate abort signal" this comment already promises above (#307 AC7's mid-load
 *  close). Dropping it here silently disconnects that abort from the network layer: the caller's
 *  `AbortController.abort()` still flips `signal.aborted`, but nothing downstream ever rejects
 *  the fetch on it, so the abandoned load just runs to completion against a session nobody wants
 *  any more. If a future rewrite unpacks this request shape again, carry `signal` with it. */
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
    // #199: pipe the backend's Serilog console output into the same channel,
    // at its own level. Only applies to a backend we spawn — an attached
    // dev-launched one still logs to its own terminal.
    onOutput: makeBackendLogForwarder(channel),
    // #205: make the backend's Serilog minimum level follow the channel's
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

/** Is Modbench itself the deployer? One reading of the setting, shared by the context key that
 *  gates the declarative `when` clauses and by the header's deployment row — two answers that
 *  disagreed would put an icon and its readout in different states. */
function isStandaloneDeployment(): boolean {
  return (meditConfig().get('mods.deploymentMode') ?? 'external') !== 'external';
}

/** Seed and watch the deployment-mode context key (standalone vs external manager). */
function registerDeploymentModeContext(context: vscode.ExtensionContext): void {
  // Deploy/Purge/Launch are standalone-only; hidden when an external manager owns
  // deployment. Default external for the alpha — MO2 stays the deployer/launcher
  // until standalone deploy ships post-alpha (#96, #186).
  const applyDeploymentMode = () => {
    void vscode.commands.executeCommand('setContext', 'modbench.deploymentStandalone', isStandaloneDeployment());
  };
  applyDeploymentMode();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('modbench.mods.deploymentMode')) {
        applyDeploymentMode();
        loadoutHeaderProvider?.refresh(); // the deployment row appears/disappears with the mode
      }
    }),
  );
}

export function deactivate() {
  backendManager?.dispose();
}

/** Deploy / Purge / Launch Game commands (standalone mode). Orchestrates the
 *  existing resolver + deployer over the active MO2 instance; surfacing goes
 *  through an injected reporter per ADR-0026. */
function registerDeployCommands(
  instanceRoot: string,
  modlistSource: Mo2ModlistSource,
  outputChannel: vscode.LogOutputChannel,
  gameDirResolver: GameDirectoryResolver,
): vscode.Disposable[] {
  const config = meditConfig;
  const detectPaths = makeDetectPaths();

  const reporter = makeReporter(outputChannel, 'deploy');

  const resolveGd = async () => {
    // #357: the single game-directory resolver, shared with the views/drift tracker/session
    // launch — memoised and invalidated only when modbench.mods.gameDirectory changes.
    const gd = await gameDirResolver.resolve();
    if (!gd) {
      reporter.report('error', 'No game directory found. Set modbench.mods.gameDirectory to your Stock Game Folder or Steam install.');
    }
    return gd;
  };

  const resolveLoadOrder = async (): Promise<LoadOrderDeployment[]> => {
    const target = (config().get('game.pluginsTxtPath') as string) || (await detectPaths())?.pluginsTxt;
    if (!target) return [];
    const profile = await modlistSource.getActiveProfile();
    return [{ source: path.join(instanceRoot, 'profiles', profile, 'plugins.txt'), target }];
  };

  const runDeploy = async (gd: GameDirectory) => {
    const index = buildFileConflictIndex(await modlistSource.readModlist(), instanceRoot, (msg) => outputChannel.debug(msg));
    await deploy(instanceRoot, gd, await index, reporter, { loadOrder: await resolveLoadOrder() });
  };

  return [
    vscode.commands.registerCommand('modbench.modList.deploy', async () => {
      try {
        const gd = await resolveGd();
        if (!gd) return;
        await runDeploy(gd);
        loadoutHeaderProvider?.refresh();
        void vscode.window.showInformationMessage('Modbench: Mods deployed.');
      } catch (err) {
        reporter.report('error', 'Deploy failed.', err instanceof Error ? err.message : String(err));
      }
    }),
    vscode.commands.registerCommand('modbench.modList.purge', async () => {
      try {
        const gd = await resolveGd();
        if (!gd) return;
        await purge(instanceRoot, gd, reporter);
        loadoutHeaderProvider?.refresh();
        void vscode.window.showInformationMessage('Modbench: Deployed mods purged.');
      } catch (err) {
        reporter.report('error', 'Purge failed.', err instanceof Error ? err.message : String(err));
      }
    }),
  ];
}

/** #188 contributes one task per entry in MO2's executables registry under this type; #247's
 *  Launch… is the single affordance that runs one of them. Named here so the provider that
 *  lands with #188 has one place to agree with. */
const LAUNCH_TASK_TYPE = 'modbench';

/** #247: Launch… — one affordance no matter how many executables exist, because the registry
 *  decides what is launchable, not the title bar. It reads the contributed tasks at
 *  invocation (so an executable added in MO2 appears without a reload) and executes the
 *  selection; it never resolves a binary itself. The retired Launch Game did the opposite —
 *  it deployed, then spawned a hardcoded `Fallout4.exe`, locking the command to one game and
 *  conflating two separate operations.
 *
 *  Until #188 lands there are no such tasks, so this says so rather than guessing a path.
 *  Wiring the picker to the registry is #293. */
function registerLaunchCommand(outputChannel: vscode.LogOutputChannel): vscode.Disposable {
  return vscode.commands.registerCommand('modbench.launch', async () => {
    const tasks = await vscode.tasks.fetchTasks({ type: LAUNCH_TASK_TYPE });
    if (tasks.length === 0) {
      outputChannel.info('[extension] Launch…: no launchable tasks contributed yet (#188)');
      void vscode.window.showInformationMessage(
        'Modbench: No launch targets yet — the executables you configured in MO2 appear here once tool launching lands.',
      );
      return;
    }
    const picked = await vscode.window.showQuickPick(
      tasks.map((task) => ({ label: task.name, task })),
      { placeHolder: 'Launch' },
    );
    if (!picked) return;
    await vscode.tasks.executeTask(picked.task);
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

const RECORD_PANEL_KEY = '__record_view__';

// Issue #230 (#426: restored): the temp directory every extended-editor tab writes under —
// session-static (the same value every panel gets), so it lives at module scope rather than in
// any per-panel bundle.
const extendedFieldEditorTempRoot = path.join(os.tmpdir(), 'modbench-medit-fields');

// #282: pulled out of openRecordPanel purely for its line budget (same reasoning as
// createReferencedByTree/registerReferencedByCopyCommand above) — wires a freshly created panel
// into activeRecordTracker. FormKey is recorded before the panel is declared active, so a brand
// new panel fires the Referenced By retarget exactly once, already carrying it (see
// ActiveRecordTracker's own doc comment on ordering). onDidChangeViewState only needs to announce
// *gaining* focus: losing it to another record panel is that other panel's own
// onDidChangeViewState(active) firing, which naturally supersedes this one
// (ActiveRecordTracker.setActivePanel dedupes same-panel calls), and losing it to a closed panel
// is removePanel's job.
function wireActiveRecordTracking(
  panel: vscode.WebviewPanel, formKey: string | undefined, activeRecordTracker: ActiveRecordTracker<vscode.WebviewPanel>,
): void {
  if (formKey) activeRecordTracker.setFormKey(panel, formKey);
  activeRecordTracker.setActivePanel(panel);
  panel.onDidChangeViewState(() => {
    if (panel.active) activeRecordTracker.setActivePanel(panel);
  });
  panel.onDidDispose(() => activeRecordTracker.removePanel(panel));
}

// #200/#208: bundled as one trailing param (not two/three) — kept the parameter count under the
// lint budget and there's no reason to unpack them only to repack below. recordPanels is every
// open 'modbench'-viewType panel (main *and* any "Beside" one — see modbench.openEditorBeside
// above); the pending-cell native menu commands broadcast a changeId to every panel
// in it and let each one self-filter (see RecordPanel.tsx) rather than picking "the right one"
// here.
interface OpenRecordPanelDeps {
  routerDeps: RouteRecordPanelMessageDeps;
  recordPanels: Set<vscode.WebviewPanel>;
  // #282: kept current at both branches below (reuse-and-retarget, create) — the Referenced By
  // view's whole input, replacing the old showReferencedBy(node) command argument.
  activeRecordTracker: ActiveRecordTracker<vscode.WebviewPanel>;
  // #284: whether this open should reuse/retarget the singleton RECORD_PANEL_KEY panel (plain
  // "Open"/"Compare") or always create a fresh, non-retargeting panel ("Open Editor to the Side",
  // single or batched). Deliberately independent of `viewColumn` below — a batched Beside open's
  // 2nd..Nth panel needs a concrete resolved ViewColumn (not the Beside sentinel, see
  // openBesideRecordPanels) while still being non-retargeting, so `viewColumn !== Beside` can no
  // longer stand in for "is this the singleton" the way it used to.
  singleton: boolean;
}

function openRecordPanel(
  context: vscode.ExtensionContext,
  openPanels: Map<string, vscode.WebviewPanel>,
  title: string,
  formKey: string | undefined,
  port: number,
  viewColumn: vscode.ViewColumn,
  { routerDeps, recordPanels, activeRecordTracker, singleton }: OpenRecordPanelDeps,
): void {
  if (singleton) {
    const existing = openPanels.get(RECORD_PANEL_KEY);
    if (existing) {
      existing.title = title;
      existing.reveal();
      // #282: setFormKey before setActivePanel so a genuinely new record fires exactly once,
      // already carrying it — see ActiveRecordTracker's own doc comment on ordering.
      if (formKey) {
        existing.webview.postMessage({ type: EXTENSION_TO_WEBVIEW.LOAD_RECORD, formKey } satisfies ExtensionToWebview);
        activeRecordTracker.setFormKey(existing, formKey);
      }
      activeRecordTracker.setActivePanel(existing);
      return;
    }
  }

  const panel = vscode.window.createWebviewPanel('modbench', title, viewColumn, {
    enableScripts: true,
    localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'out', 'webview'))],
  });

  if (singleton) {
    openPanels.set(RECORD_PANEL_KEY, panel);
    panel.onDidDispose(() => openPanels.delete(RECORD_PANEL_KEY));
  }

  recordPanels.add(panel);
  panel.onDidDispose(() => recordPanels.delete(panel));

  wireActiveRecordTracking(panel, formKey, activeRecordTracker);

  panel.webview.onDidReceiveMessage((msg: unknown) => {
    // Issue #210/#211/#230 (#426: restored): every reply below must reach the one panel that
    // asked, never a broadcast (see messages.ts' FORM_KEY_PICKED/CONDITION_FUNCTION_PICKED/
    // OPEN_EXTENDED_EDITOR doc comments) — routerDeps itself is shared across every panel (built
    // once in registerRecordViewCommands), so these are the per-panel fields, rebuilt fresh on
    // every message with the panel this closure already holds.
    const reply = (m: ExtensionToWebview) => { void panel.webview.postMessage(m); };
    void routeRecordPanelMessage(msg, {
      ...routerDeps,
      formKeyPicker: { repository: routerDeps.repository, reply },
      conditionFunctionPicker: { repository: routerDeps.repository, reply },
      // Issue #230: tempRoot/log/reporter are session-static (the same values every panel would
      // get); only `reply` genuinely varies per panel — bundled here anyway, matching
      // formKeyPicker's own reconstruction on this object.
      extendedFieldEditor: {
        tempRoot: extendedFieldEditorTempRoot,
        reply,
        log: (m: string) => routerDeps.channel.debug(m),
        reporter: routerDeps.reporter,
      },
    });
  });

  const scriptUri = panel.webview.asWebviewUri(
    vscode.Uri.file(path.join(context.extensionPath, 'out', 'webview', 'assets', 'main.js'))
  );

  panel.webview.html = buildWebviewHtml({
    formKey,
    port,
    scriptUri: scriptUri.toString(),
    cspSource: panel.webview.cspSource,
  });
}

// #284: a right-clicked Plugins-tree record/placed-reference row, a multi-selection of them, or
// the Referenced By group row's own plain shape — whichever one duck-types against, resolved to
// the (formKey, label) pair openRecordPanel needs. `'kind' in node` (not `instanceof`), matching
// recordCopyIdentity's existing convention above — keeps this testable against plain object
// literals shaped like the real tree nodes, with no dependency on constructing one.
function recordOpenIdentity(node: unknown): { formKey: string; label: string } | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const n = node as { kind?: string; record?: { formKey?: string }; placed?: { formKey?: string };
    formKey?: string; label?: unknown };
  const formKey = 'kind' in n
    ? n.kind === 'record' ? n.record?.formKey : n.kind === 'placed' ? n.placed?.formKey : undefined
    : n.formKey;
  if (!formKey) return undefined;
  return { formKey, label: typeof n.label === 'string' ? n.label : formKey };
}

// #284: opens one non-retargeting panel per identity, all landing as tabs in a single new editor
// group beside the currently active one — not one new group per record. `ViewColumn.Beside` only
// resolves correctly once: after the first panel is created it becomes the active editor, so a
// second `createWebviewPanel(..., ViewColumn.Beside, ...)` call would resolve beside *that* panel
// instead, cascading into a new column per record. Resolving it once — via
// `tabGroups.activeTabGroup.viewColumn` right after each create — and reusing that concrete
// column for every remaining identity is what keeps them stacked as tabs in one group instead.
// Not `panel.viewColumn`: that getter stays `undefined` synchronously right after
// `createWebviewPanel` returns (its resolution is a round trip to the renderer that hasn't landed
// yet), so it can never supply the concrete column the very next iteration needs — confirmed by
// instrumenting it directly against this function's own multi-select integration test.
function openBesideRecordPanels(
  context: vscode.ExtensionContext,
  openPanels: Map<string, vscode.WebviewPanel>,
  identities: { formKey: string; label: string }[],
  port: number,
  deps: Omit<OpenRecordPanelDeps, 'singleton'>,
): void {
  let column: vscode.ViewColumn = vscode.ViewColumn.Beside;
  for (const { formKey, label } of identities) {
    openRecordPanel(context, openPanels, label, formKey, port, column, { ...deps, singleton: false });
    column = vscode.window.tabGroups.activeTabGroup.viewColumn;
  }
}

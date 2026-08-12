import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as cp from 'child_process';
import { BackendManager } from './medit/BackendManager';
import { backendLogLevelArgs, makeBackendLogForwarder } from './medit/backendLog';
import { createApiClient, type ApiClient, type MasterIssue } from './medit/ApiClient';
import { detectGamePaths } from './medit/GamePathDetector';
import { SessionController } from './medit/SessionController';
import { makeReloadSession } from './medit/reloadSession';
import { LoadMoreNode, PlacedGroupNode, PlacedNode, PluginTreeNode, PluginTreeProvider, RecordNode, headerFormKeyFor } from './medit/PluginTreeProvider';
import { PendingChangesTreeProvider, PendingGroupNode, PendingLeafNode, type PendingTreeNode } from './medit/PendingChangesTreeProvider';
import {
  ReferencedByTreeProvider, ReferencedByGroupNode, referencedByCopyText, type ReferencedByTreeNode,
} from './medit/ReferencedByTreeProvider';
import { ActiveRecordTracker } from './medit/ActiveRecordTracker';
import { ApiPluginRepository } from './medit/PluginRepository';
import { FilterCodeLensProvider } from './medit/FilterCodeLensProvider';
import { buildWebviewHtml } from './medit/webviewHtml';
import {
  EXTENSION_TO_WEBVIEW, type ArrayElementContext, type ArrayParentContext,
  type ColumnHeaderContext, type ExtensionToWebview, type PendingCellContext,
  type VmadScriptsContext, type VmadScriptContext, type VmadPropertyContext,
} from './medit/messages';
import {
  routeRecordPanelMessage, revealPendingChange, pickScriptNameViaInputBox,
  type RevealDeps, type RouteRecordPanelMessageDeps,
} from './medit/recordPanelMessageRouter';
import { Mo2ModlistSource } from './modmanager/mo2/Mo2ModlistSource';
import { isMo2Instance } from './modmanager/detectMo2Instance';
import { ModListProvider, ModNode, OverwriteNode, SeparatorNode, type ModlistNode } from './modmanager/ModListProvider';
import { createOverwriteWatcher } from './modmanager/overwriteWatcher';
import { createModsWatcher } from './modmanager/modsWatcher';
import { OverwriteDecorationProvider } from './modmanager/OverwriteDecorationProvider';
import { PluginListProvider, pluginFileOf, orderIssueMastersOf, type PluginListNode } from './modmanager/PluginListProvider';
import { PluginsTreeComposite } from './PluginsTreeComposite';
import { resolveGameDirectory, type GameDirectory, type DetectPaths } from './modmanager/gameDirectory';
import { deploy, isDeployed, purge, type LoadOrderDeployment, type Reporter } from './modmanager/deployer';
import { buildFileConflictIndex } from './modmanager/fileConflictIndex';
import { buildExplicitPluginsWithOrigin } from './modmanager/explicitSession';
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
import { makeReporter } from './reporter';
import { LoadoutHeaderProvider } from './LoadoutHeaderProvider';

let backendManager: BackendManager | undefined;
// #247: the Loadout header re-reads its rows whenever workspace-scope state moves. Module
// level for the same reason pluginsTree below is — the choke points that move that state
// (exitToLoadout, switchProfile) are module-level functions too.
let loadoutHeaderProvider: LoadoutHeaderProvider | undefined;
// #270: the merged Plugins tree. Module level for the same reason as the above — the session
// starting and stopping is what puts chevrons on its rows, and both choke points for that
// (enterEditing, exitToLoadout) are module-level.
let pluginsTree: PluginsTreeComposite<PluginListNode, PluginTreeNode> | undefined;
// #295: `enterEditing` itself, built once inside `registerLoadoutView` (absent with no
// workspace, or one that isn't an MO2 instance — see that function's own early returns).
// Module level for the same reason as the above: `modbench.reloadSession` is registered
// earlier in `activate()` (inside `registerEditorCommands`) than `registerLoadoutView` builds
// this closure, so it can't be threaded in as a constructor argument — only reached by both
// sides holding the one module-level reference. Assigned exactly once, where `enterEditing` is
// built; every reader treats it as possibly-absent (activation still finishing, or no
// workspace) rather than assuming it exists.
let enterEditingFn: ((progress?: vscode.Progress<{ message?: string }>) => Promise<void>) | undefined;

const meditConfig = () => vscode.workspace.getConfiguration('modbench');

/** #192: stub provider for the Mods view when the workspace isn't an MO2
 *  instance. Always empty so VS Code's `viewsWelcome` contribution (gated on
 *  `modbench.workspaceIsMo2Instance`) renders instead of the tree — getTreeItem
 *  is unreachable since getChildren never yields an element to render. */
const NOT_MO2_INSTANCE_PROVIDER: vscode.TreeDataProvider<never> = {
  getTreeItem: () => { throw new Error('unreachable — NOT_MO2_INSTANCE_PROVIDER never yields children'); },
  getChildren: () => [],
};

/** The staged-work signal, applied to both surfaces that report it: the context key that
 *  gates Save All / Revert All, and (#247) the view's numeric badge, which is how staged work
 *  stays visible on the activity-bar icon while the view is collapsed. One number drives both,
 *  so they cannot disagree. No badge at zero — a "0" reads as a state worth looking at.
 *
 *  The view is passed as a getter because it is constructed after the provider that reports
 *  into it; by the time a count arrives, it exists (same ordering note as createReferencedByTree). */
function makePendingStateHandler(
  getView: () => vscode.TreeView<PendingTreeNode> | undefined,
): (stagedGroups: number) => void {
  return (stagedGroups) => {
    void vscode.commands.executeCommand('setContext', 'modbench.hasPendingChanges', stagedGroups > 0);
    const view = getView();
    if (!view) return;
    view.badge = stagedGroups === 0
      ? undefined
      : { value: stagedGroups, tooltip: `${stagedGroups} pending change group${stagedGroups === 1 ? '' : 's'}` };
  };
}

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
    };
  };
}

/** Leave editing: tear down the editing backend. #273: there is no separate loadout view mode
 *  to switch back to any more — the loadout views were never hidden (#268), and Pending Changes /
 *  Referenced By govern their own visibility (staged work, always-present respectively). */
function exitToLoadout(): void {
  // #270: the chevrons go with the session. Cleared before the backend stops, so no row can be
  // expanded into a backend that is on its way down.
  pluginsTree?.setSession(undefined);
  backendManager?.stop();
}

/** The filter widget — one implementation for every list view (Mods, Plugin List, Plugins
 *  tree, Downloads): a transient InputBox that live-narrows as the user types and restores
 *  the unfiltered list on dismiss. Registers `commandId` to open it.
 *
 *  #247: there used to be two of these, the second hand-rolled inside the Mods command body
 *  purely to carry a toggle button — so "filter" meant three different things across five
 *  title bars. `toggle` folds that case in as an option; it is also why `setFilter` takes the
 *  toggle state as a second argument that the three plain call sites ignore.
 *
 *  The clear-on-dismiss below is the whole of #255: the filter does not survive losing focus,
 *  which makes it usable only while typing. It is deliberately still here — fixing it is a
 *  UX decision (a persistent chip and an explicit clear), and now that there is one widget
 *  that fix lands on all four views at once. */
function registerFilterBoxCommand(
  commandId: string,
  placeholder: string,
  setFilter: (text: string, toggleOn: boolean) => void,
  toggle?: { icon: string; label: string },
): vscode.Disposable {
  return vscode.commands.registerCommand(commandId, () => {
    const box = vscode.window.createInputBox();
    box.placeholder = placeholder;
    let toggleOn = true;
    const updateButtons = () => {
      if (!toggle) return;
      box.buttons = [{ iconPath: new vscode.ThemeIcon(toggle.icon), tooltip: `${toggle.label} (${toggleOn ? 'on' : 'off'})` }];
    };
    updateButtons();
    box.onDidTriggerButton(() => {
      toggleOn = !toggleOn;
      updateButtons();
      setFilter(box.value, toggleOn);
    });
    box.onDidChangeValue((text) => setFilter(text, toggleOn));
    box.onDidHide(() => { setFilter('', true); box.dispose(); });
    box.show();
  });
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
    return detectGamePaths();
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

export function activate(context: vscode.ExtensionContext) {
  const cfg = vscode.workspace.getConfiguration('modbench');
  const port: number = cfg.get('backendPort') ?? 5172;

  const outputChannel = vscode.window.createOutputChannel('Modbench', { log: true });
  context.subscriptions.push(outputChannel);
  // #198: `log` is now a compat shim (defaults to .info) for modules taking a flat `(msg) => void`.
  const log = (msg: string) => outputChannel.info(msg);

  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  context.subscriptions.push(statusBarItem);

  backendManager = createBackendManager(port, outputChannel, statusBarItem);

  const client = createApiClient(port);
  const repository = new ApiPluginRepository(client, log);
  const treeProvider = new PluginTreeProvider(repository, log);
  const changeGroupTreeProvider = new PendingChangesTreeProvider(
    client, log, makePendingStateHandler(() => changeGroupTreeView));
  const openPanels = new Map<string, vscode.WebviewPanel>();
  const recordPanels = new Set<vscode.WebviewPanel>();
  // #282: the Referenced By view's input — which record panel is active and what FormKey it
  // shows — replacing the old showReferencedBy(node) command argument.
  const activeRecordTracker = new ActiveRecordTracker<vscode.WebviewPanel>();
  const { scriptsPath, filterProvider } = setupScripts(cfg);

  const setFilterActive = (active: boolean, sql?: string) => {
    void vscode.commands.executeCommand('setContext', 'modbench.filterActive', active);
    filterProvider.setActiveSql(active ? (sql ?? null) : null);
  };

  const controller = new SessionController({
    client,
    repository,
    log,
    refreshTree: () => treeProvider.refresh(),
    refreshGroupTree: () => changeGroupTreeProvider.refresh(),
    setStatusText: (t) => { statusBarItem.text = t; },
    showWarning: (msg) => { void vscode.window.showWarningMessage(msg); },
    showError: (msg) => { void vscode.window.showErrorMessage(msg); },
    setFilterActive,
  });

  const changeGroupTreeView: vscode.TreeView<PendingTreeNode> = vscode.window.createTreeView('modbench.changeGroupTree', {
    treeDataProvider: changeGroupTreeProvider,
    canSelectMany: true,
    // #247 rule 7: hierarchical — a multi-member ChangeGroup expands into its member leaves.
    showCollapseAll: true,
  });
  const { referencedByTreeView, activeRecordSubscription } = createReferencedByTree(client, log, activeRecordTracker);
  const { modListProvider, downloadsProvider, pluginListProvider } = registerLoadoutSurfaces({ context, log, outputChannel, controller, changeGroupTreeProvider, recordBrowser: treeProvider, sessionPluginFiles: sessionPluginFilesFrom(repository) });

  context.subscriptions.push(
    changeGroupTreeView,
    referencedByTreeView,
    activeRecordSubscription,
    vscode.languages.registerCodeLensProvider({ language: 'sql' }, filterProvider),
    ...registerEditorCommands({
      context, openPanels, recordPanels, activeRecordTracker, port, treeProvider, controller, repository, scriptsPath, changeGroupTreeProvider, changeGroupTreeView, referencedByTreeView, log, outputChannel,
    }),
  );

  // The backend is now spawned lazily on entering editing (Launch mEdit) and
  // torn down on Close mEdit — the extension owns its lifecycle (ADR-0022). There
  // is no auto-connect / auto-wizard at activation; show a neutral idle state.
  statusBarItem.text = '$(plug) mEdit';

  // Exposed for integration tests (pinned Overwrite row #82; editing tree after launch #75;
  // leveled output channel #198; Downloads tree #233; merged Plugins tree #270;
  // modbench.hasPendingChanges toggles both ways #273) — unused in production. #273: treeView
  // (the old modbench.pluginTree's own TreeView) is gone along with that view — treeProvider
  // itself stays, since it still supplies the merged tree's children.
  return {
    modListProvider, downloadsProvider, pluginListProvider, pluginsTree, treeProvider,
    changeGroupTreeProvider, changeGroupTreeView, outputChannel,
  };
}


interface EditorCommandDeps {
  context: vscode.ExtensionContext;
  openPanels: Map<string, vscode.WebviewPanel>;
  // #208: every open 'modbench'-viewType record panel — see openRecordPanel's recordPanels
  // param and modbench.pendingCell.saveGroup/revertGroup below.
  recordPanels: Set<vscode.WebviewPanel>;
  // #282: which of recordPanels is active, and what FormKey each shows — openRecordPanel keeps
  // this current; the Referenced By view retargets from it, not from a command argument.
  activeRecordTracker: ActiveRecordTracker<vscode.WebviewPanel>;
  port: number;
  treeProvider: PluginTreeProvider;
  controller: SessionController;
  repository: ApiPluginRepository;
  scriptsPath: string;
  // Issue #140: the record panel's Pending column reveals a change into the Pending Changes
  // tree — resolve the change id here, then TreeView.reveal it.
  changeGroupTreeProvider: PendingChangesTreeProvider;
  changeGroupTreeView: vscode.TreeView<PendingTreeNode>;
  // Issue #282: the Referenced By view itself — needed for its Copy command's selection
  // fallback (`.selection`), same shape as treeView/changeGroupTreeView above. The provider is
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
    ...registerChangeGroupCommands(deps),
    ...registerCopyCreateCommands(deps),
    ...registerColumnHeaderCommands(deps),
    ...registerArrayOpCommands(deps),
    ...registerVmadOpCommands(deps),
  ];
}

/** Record view/navigation + filter commands. */
function registerRecordViewCommands(deps: EditorCommandDeps): vscode.Disposable[] {
  const {
    context, openPanels, recordPanels, activeRecordTracker, port, treeProvider, controller, scriptsPath,
    changeGroupTreeProvider, changeGroupTreeView, referencedByTreeView, log, outputChannel, repository,
  } = deps;
  const reveal: RevealDeps = {
    provider: changeGroupTreeProvider, view: changeGroupTreeView, log,
    reporter: makeReporter(outputChannel, 'revealPendingChange'),
  };
  // #210/#211/#212/#225/#230: formKeyPicker/conditionFunctionPicker/revertGroupConfirm/
  // addScriptName/clipboardRead/extendedFieldEditor are left undefined here — each `reply` must
  // post back to the one panel that asked (never a broadcast), so openRecordPanel rebuilds these
  // bundles per panel at the onDidReceiveMessage call site rather than sharing one instance the
  // way reveal/channel are.
  const routerDeps: RouteRecordPanelMessageDeps = {
    reveal, channel: outputChannel, formKeyPicker: undefined, conditionFunctionPicker: undefined,
    revertGroupConfirm: undefined, addScriptName: undefined, clipboardRead: undefined, extendedFieldEditor: undefined,
    // Issue #224: COPY_TO_CLIPBOARD's ADR-0026 surfacing on a failed clipboard write — shared
    // like `channel` above, not rebuilt per panel, since there's no per-panel reply to route.
    reporter: makeReporter(outputChannel, 'copyToClipboard'),
  };
  return [
    vscode.commands.registerCommand('modbench.closeMedit', () => exitToLoadout()),
    registerReloadSessionCommand(controller, outputChannel),
    vscode.commands.registerCommand('modbench.openEditor', (args?: { formKey?: string; label?: string }) => {
      openRecordPanel(context, openPanels, args?.label ?? args?.formKey ?? 'mEdit', args?.formKey, port,
        vscode.ViewColumn.One, { routerDeps, recordPanels, repository, activeRecordTracker });
    }),
    // Issue #213: Referenced By's named "Open to the Side" (ADR-0033), not a right-click side effect.
    vscode.commands.registerCommand('modbench.openEditorBeside', (args?: { formKey?: string; label?: string }) => {
      openRecordPanel(context, openPanels, args?.label ?? args?.formKey ?? 'mEdit', args?.formKey, port,
        vscode.ViewColumn.Beside, { routerDeps, recordPanels, repository, activeRecordTracker });
    }),
    vscode.commands.registerCommand('modbench.openCompare', () => {
      openRecordPanel(context, openPanels, 'mEdit', undefined, port, vscode.ViewColumn.One,
        { routerDeps, recordPanels, repository, activeRecordTracker });
    }),
    ...registerPendingCellCommands(reveal, recordPanels),
    vscode.commands.registerCommand('modbench.loadMore', (node: LoadMoreNode) => treeProvider.loadMore(node)),
    vscode.commands.registerCommand('modbench.newPlugin', async () => {
      const name = await promptPluginName();
      if (name) await controller.createPlugin(name);
    }),
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
      await controller.setFilter(sql);
    }),
    vscode.commands.registerCommand('modbench.setFilterFromDocument', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const sql = editor.document.getText();
      await controller.setFilter(sql);
    }),
    vscode.commands.registerCommand('modbench.clearFilter', () => controller.clearFilter()),
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

// #295: modbench.reloadSession — pulled out of registerRecordViewCommands purely for its line
// budget, same reasoning as registerReferencedByCopyCommand below. Re-runs the session load
// (makeEnterEditing — the same path Launch mEdit and the crash-restart handler take), not a
// tree re-read; confirms modally first only when there's staged work to lose
// (makeReloadSession). Guarded on enterEditingFn: registration order means this command exists
// before registerLoadoutView builds it (no workspace, or one that isn't an MO2 instance, leaves
// it permanently unset) — invoking it too early must fail visibly, not throw a TypeError at
// the user.
function registerReloadSessionCommand(controller: SessionController, outputChannel: vscode.LogOutputChannel): vscode.Disposable {
  return vscode.commands.registerCommand('modbench.reloadSession', async () => {
    const enter = enterEditingFn;
    if (!enter) {
      outputChannel.error('[extension] modbench.reloadSession: no editing session to reload (no workspace, or not an MO2 instance)');
      void vscode.window.showErrorMessage('Modbench: There is no editing session to reload.');
      return;
    }
    await makeReloadSession({
      hasPendingChanges: () => controller.hasPendingChanges(),
      confirm: async () => (await vscode.window.showWarningMessage(
        'Modbench: Reload the session? Backend state is rebuilt from the current modlist — any staged changes not yet saved will be discarded.',
        { modal: true }, 'Reload',
      )) === 'Reload',
      reload: () => Promise.resolve(vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'mEdit' },
        (progress) => enter(progress),
      )),
    })();
  });
}

// #282: the Referenced By view's own Copy — pulled out of registerRecordViewCommands purely for
// its line budget, same reasoning as createReferencedByTree's own split from `activate`. A
// keybinding (Ctrl+C while focused) and a view/item/context entry both invoke this one command
// (package.json), the same "keybinding + menu, one command" shape modbench.deleteRecord already
// uses; ADR-0033's "no action reachable two ways" is about redundant *affordances* for one action
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

// #208: the pending cell's right-click menu is VS Code's own `webview/context` contribution now
// (contributes.menus in package.json) — these are the three commands it invokes, each receiving
// the cell's merged data-vscode-context object (at minimum `changeId`) as its sole argument.
// Reveal's work (resolving a changeId to a Pending Changes tree node) is entirely
// extension-host-side, so it calls the existing revealPendingChange directly — no webview round
// trip. Save Group/Revert Group's work (RecordSessionClient HTTP, the multi-member confirm
// dialog, the partial-save/stale-reindex banner) only exists in the webview, so those broadcast
// to every open record panel; each self-filters on whether it holds the changeId.
function registerPendingCellCommands(reveal: RevealDeps, recordPanels: Set<vscode.WebviewPanel>): vscode.Disposable[] {
  const broadcast = (
    type: typeof EXTENSION_TO_WEBVIEW.PENDING_CELL_SAVE_GROUP | typeof EXTENSION_TO_WEBVIEW.PENDING_CELL_REVERT_GROUP,
    changeId: string | undefined,
  ) => {
    if (!changeId) return;
    for (const panel of recordPanels) void panel.webview.postMessage({ type, changeId } satisfies ExtensionToWebview);
  };
  return [
    vscode.commands.registerCommand('modbench.pendingCell.reveal', (ctx?: PendingCellContext) => {
      if (ctx?.changeId) void revealPendingChange(ctx.changeId, reveal);
    }),
    vscode.commands.registerCommand('modbench.pendingCell.saveGroup', (ctx?: PendingCellContext) => {
      broadcast(EXTENSION_TO_WEBVIEW.PENDING_CELL_SAVE_GROUP, ctx?.changeId);
    }),
    vscode.commands.registerCommand('modbench.pendingCell.revertGroup', (ctx?: PendingCellContext) => {
      broadcast(EXTENSION_TO_WEBVIEW.PENDING_CELL_REVERT_GROUP, ctx?.changeId);
    }),
  ];
}

/** Delete records and save/revert change groups. */
/** The component a node acts on (keyed by a member change id, ADR-0028): a group node is
 *  its own component, a top-level singleton is a group of one, and a member resolves to the
 *  multi-member group it belongs to. canSelectMany lets a member land in a selection, so we
 *  map it to its group rather than silently drop it (ADR-0026). Empty/error nodes yield none. */
function owningComponent(node: PendingTreeNode): { componentId: string; group?: PendingGroupNode } | undefined {
  if (node instanceof PendingGroupNode) return { componentId: node.componentId, group: node };
  if (node instanceof PendingLeafNode) {
    if (node.contextValue === 'pendingGroup') return { componentId: node.componentId };
    if (node.parent) return { componentId: node.parent.componentId, group: node.parent };
  }
  return undefined;
}

/** The full multi-selection when several nodes are chosen, else the single invoked node. */
function selectedPendingNodes(node?: PendingTreeNode, allSelected?: PendingTreeNode[]): PendingTreeNode[] {
  if (allSelected?.length) return allSelected;
  return node ? [node] : [];
}

/** Deduped component ids across the selection — two members of one group collapse to it. */
function selectedComponentIds(node?: PendingTreeNode, allSelected?: PendingTreeNode[]): string[] {
  const ids = selectedPendingNodes(node, allSelected)
    .map(owningComponent)
    .filter((r): r is { componentId: string; group?: PendingGroupNode } => !!r)
    .map(r => r.componentId);
  return [...new Set(ids)];
}

/** The multi-member groups a save/revert would touch — selected group nodes plus the owning
 *  groups of any selected members — deduped, so a confirmation can list all linked edits. */
function selectedGroups(node?: PendingTreeNode, allSelected?: PendingTreeNode[]): PendingGroupNode[] {
  const groups = new Map<string, PendingGroupNode>();
  for (const n of selectedPendingNodes(node, allSelected)) {
    const g = owningComponent(n)?.group;
    if (g) groups.set(g.componentId, g);
  }
  return [...groups.values()];
}

/** #270: record nodes now appear in two views, so "what is selected" is no longer one view's
 *  question. VS Code passes the clicked node and the full selection for a context-menu
 *  invocation, but nothing at all for the Delete keybinding — hence the fallback, which follows
 *  whichever plugin tree the user last selected in rather than naming one of them. */
let lastRecordSelection: readonly (RecordNode | PlacedNode)[] = [];

function trackRecordSelection(view: vscode.TreeView<PluginTreeNode | PluginListNode>): vscode.Disposable {
  return view.onDidChangeSelection((e) => {
    const records = e.selection.filter((n): n is RecordNode | PlacedNode => n instanceof RecordNode || n instanceof PlacedNode);
    if (records.length > 0) lastRecordSelection = records;
    else if (e.selection.length > 0) lastRecordSelection = []; // selected something that isn't a record
  });
}

function registerChangeGroupCommands(deps: EditorCommandDeps): vscode.Disposable[] {
  const { controller } = deps;
  return [
    // #273: the old modbench.pluginTree that fed `lastRecordSelection` here is gone — the merged
    // Plugins tree (modbench.pluginListTree) already feeds the same tracker from its own
    // registration (registerPluginListView), so nothing here needs to re-register it.
    vscode.commands.registerCommand('modbench.deleteRecord', async (item?: RecordNode | PlacedNode, allSelected?: (RecordNode | PlacedNode)[]) => {
      const toTarget = (n: RecordNode | PlacedNode) =>
        n instanceof PlacedNode
          ? { formKey: n.placed.formKey ?? '', plugin: n.plugin }
          : { formKey: n.record.formKey, plugin: n.record.plugin };
      const toName = (n: RecordNode | PlacedNode) =>
        n instanceof PlacedNode
          ? (n.placed.editorId ?? n.placed.formKey ?? '')
          : (n.record.editorId ?? n.record.formKey);

      let targets: (RecordNode | PlacedNode)[];
      if (allSelected?.length) {
        targets = allSelected;
      } else {
        targets = lastRecordSelection.length ? [...lastRecordSelection] : item ? [item] : [];
      }
      if (targets.length === 0) {
        vscode.window.showErrorMessage('Modbench: Select one or more records in the tree first.');
        return;
      }
      const names = targets.map(toName).join(', ');
      const label = targets.length === 1 ? `Delete "${names}"?` : `Delete ${targets.length} records?`;
      const answer = await vscode.window.showWarningMessage(label, { modal: true }, 'Delete');
      if (answer !== 'Delete') return;
      await controller.deleteRecords(targets.map(toTarget));
    }),
    vscode.commands.registerCommand(
      'modbench.saveGroup',
      async (node?: PendingTreeNode, allSelected?: PendingTreeNode[]) => {
        const ids = selectedComponentIds(node, allSelected);
        if (ids.length === 0) return;
        if (ids.length === 1) await controller.saveGroup(ids[0]);
        else await controller.saveGroups(ids);
      }),
    vscode.commands.registerCommand(
      'modbench.revertGroup',
      async (node?: PendingTreeNode, allSelected?: PendingTreeNode[]) => {
        const ids = selectedComponentIds(node, allSelected);
        if (ids.length === 0) return;
        // A revert takes the whole component, so when a multi-member group is in the
        // selection — directly or via one of its members — name every linked edit that
        // travels with it (ADR-0029); the user never sees a raw 409 for a partial revert.
        const groups = selectedGroups(node, allSelected);
        if (groups.length > 0) {
          const members = groups.flatMap(g =>
            // Issue #110: xEdit-parity display name, matching the Pending Changes tree's own
            // leaf label; falls back to the raw signature for an older/stale API contract.
            g.members.map(m => `${m.recordTypeDisplayName ?? m.recordType ?? ''} / ${m.formKey ?? ''} · ${m.fieldPath ?? ''}`));
          const label = groups.length > 1 ? `Revert ${groups.length} groups?` : 'Revert this group?';
          const answer = await vscode.window.showWarningMessage(
            `${label} All linked edits are reverted together.`,
            { modal: true, detail: members.join('\n') },
            'Revert');
          if (answer !== 'Revert') return;
        }
        if (ids.length === 1) await controller.revertGroup(ids[0]);
        else await controller.revertGroups(ids);
      }),
    vscode.commands.registerCommand('modbench.saveAllGroups', async () => {
      await controller.saveAllGroups();
    }),
    vscode.commands.registerCommand('modbench.revertAllGroups', async () => {
      // #247 rule 4: destructive, so it lives in the overflow menu behind a modal — the
      // native confirm surface, not a rendered one. Discarding every staged edit is not
      // undoable, and it sat one mis-click from Save All while both were title-bar icons.
      const confirm = await vscode.window.showWarningMessage(
        'Discard all pending changes?', { modal: true }, 'Revert All',
      );
      if (confirm !== 'Revert All') return;
      await controller.revertAllGroups();
    }),
  ];
}

// #209: the "New Plugin…" affordance every target-plugin QuickPick offers (Copy as Override…,
// and — new in #209 — Copy as New Record, now that they share this same picker). Add Master
// deliberately does NOT use this — see pickAddMasterCandidate below.
const NEW_PLUGIN_LABEL = '$(add) New Plugin…';

// #209: extracted from modbench.copyAsOverrideInto's command body (previously the only caller)
// so Copy as New Record can share it too — "no second picker implementation survives" applies
// to this QuickPick construction, not just the deleted React components. Candidates are every
// mutable plugin minus `excludePlugin` (the column-header menu's own right-clicked column, when
// invoked that way; the plugins-tree call site passes none, matching its pre-#209 behavior
// exactly).
async function pickTargetPlugin(
  repository: ApiPluginRepository, controller: SessionController, excludePlugin?: string,
): Promise<string | undefined> {
  const allPlugins = await repository.getPlugins();
  const mutablePlugins = allPlugins.filter(p => !p.isImmutable && p.name !== excludePlugin);
  const items: vscode.QuickPickItem[] = [
    { label: NEW_PLUGIN_LABEL, description: 'Create a new plugin and copy into it' },
    ...mutablePlugins.map(p => ({ label: p.name, description: `[${p.loadOrderIndex}]` })),
  ];
  const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Select target plugin' });
  if (!picked) return undefined;
  if (picked.label !== NEW_PLUGIN_LABEL) return picked.label;
  const name = await promptPluginName();
  if (!name) return undefined;
  await controller.createPlugin(name);
  return name;
}

// #209: Add Master's candidate list is deliberately NOT pickTargetPlugin's mutable-plugins-only
// list — a master is very often an immutable base-game/DLC esm, so filtering those out would
// remove the primary real-world case. Candidates are every loaded plugin minus the header
// record's own plugin minus whatever's already a master (pending-aware `masters`, carried by the
// column header's data-vscode-context so this needs no round trip back into the webview to ask).
// No "New Plugin…" either — declaring a brand-new empty plugin as your own master isn't
// something the retired inline picker ever offered, and nothing here asks for that scope.
async function pickAddMasterCandidate(
  repository: ApiPluginRepository, excludePlugin: string, masters: string[],
): Promise<string | undefined> {
  const allPlugins = await repository.getPlugins();
  const candidates = allPlugins.filter(p => p.name !== excludePlugin && !masters.includes(p.name));
  const items: vscode.QuickPickItem[] = candidates.map(p => ({ label: p.name, description: `[${p.loadOrderIndex}]` }));
  const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Select a master to add' });
  return picked?.label;
}

// #209: shared by every column-header command below whose real work only exists in the webview
// (see messages.ts' COLUMN_HEADER_* doc comment for why) — same broadcast-and-self-filter shape
// as #208's Save/Revert Group, just keyed on `formKey` instead of `changeId`.
function broadcastToRecordPanels(recordPanels: Set<vscode.WebviewPanel>, msg: ExtensionToWebview) {
  for (const panel of recordPanels) void panel.webview.postMessage(msg);
}

/** Copy-as-override and create-placed record commands. */
function registerCopyCreateCommands(deps: EditorCommandDeps): vscode.Disposable[] {
  const { repository, controller, recordPanels } = deps;
  return [
    // #209: extended to accept an explicit record identity (the column header's own
    // ColumnHeaderContext) alongside the plugins-tree's RecordNode/PlacedNode — resolved first by
    // instanceof so the existing tree call site is untouched. The two call shapes still diverge
    // after the target is picked: tree-invoked keeps calling controller.copyRecordTo directly
    // (unchanged); column-header-invoked broadcasts instead, so the mutation actually runs
    // through the webview's own already-working handleCopyTo (HTTP + refresh + error surfacing)
    // rather than re-deriving that in the extension host and leaving the open panel stale.
    vscode.commands.registerCommand('modbench.copyAsOverrideInto', async (arg?: RecordNode | PlacedNode | ColumnHeaderContext) => {
      let formKey: string | undefined;
      let excludePlugin: string | undefined;
      let excludeOrigin: string | undefined;
      let fromColumnHeader = false;
      if (arg instanceof PlacedNode) {
        formKey = arg.placed.formKey;
      } else if (arg instanceof RecordNode) {
        formKey = arg.record?.formKey;
      } else if (arg) {
        formKey = arg.formKey;
        excludePlugin = arg.plugin;
        excludeOrigin = arg.origin;
        fromColumnHeader = true;
      }
      if (!formKey) {
        vscode.window.showErrorMessage('Modbench: No record selected.');
        return;
      }

      const targetPlugin = await pickTargetPlugin(repository, controller, excludePlugin);
      if (!targetPlugin) return;

      if (fromColumnHeader) {
        // #202: sourcePlugin (the right-clicked column, `excludePlugin` above) is forwarded so
        // the backend copies that plugin's own version of the record, not necessarily the winner.
        // #272: sourceOrigin identifies *which* column alongside it.
        broadcastToRecordPanels(recordPanels, {
          type: EXTENSION_TO_WEBVIEW.COLUMN_HEADER_COPY_AS_OVERRIDE, formKey,
          sourcePlugin: excludePlugin!, sourceOrigin: excludeOrigin!, targetPlugin,
        });
      } else {
        await controller.copyRecordTo(formKey, targetPlugin);
      }
    }),
    vscode.commands.registerCommand('modbench.createPlaced', async (node?: PlacedGroupNode) => {
      if (!node) return;
      const recordType = await vscode.window.showQuickPick(
        [{ label: 'REFR', description: 'Placed object' }, { label: 'ACHR', description: 'Placed actor' }],
        { placeHolder: 'Select placed record type' },
      );
      if (!recordType) return;
      const templateFormKey = await vscode.window.showInputBox({
        prompt: 'Template FormKey (optional — leave blank for empty record)',
        placeHolder: 'e.g. 000001A4:Fallout4.esm',
      });
      await controller.createPlaced(
        node.plugin, node.cellFormKey, recordType.label.toLowerCase(),
        node.group, templateFormKey || undefined,
      );
    }),
  ];
}

// #209: Copy as New Record / Remove / Add Master have no plugins-tree equivalent to reuse — they
// only ever existed as column-header actions — so each gets its own new command (split out from
// registerCopyCreateCommands to stay under the file's size budget). Copy as New Record still
// shares pickTargetPlugin with modbench.copyAsOverrideInto rather than re-implementing it.
// #202: Copy All to Pending deleted outright (not just unwired) — Copy as Override
// (modbench.copyAsOverrideInto above) now covers that case via sourcePlugin.
function registerColumnHeaderCommands(deps: EditorCommandDeps): vscode.Disposable[] {
  const { repository, controller, recordPanels } = deps;
  return [
    vscode.commands.registerCommand('modbench.columnHeader.copyAsNewRecord', async (ctx?: ColumnHeaderContext) => {
      if (!ctx) return;
      const targetPlugin = await pickTargetPlugin(repository, controller, ctx.plugin);
      if (!targetPlugin) return;
      broadcastToRecordPanels(recordPanels, {
        type: EXTENSION_TO_WEBVIEW.COLUMN_HEADER_COPY_AS_NEW_RECORD, formKey: ctx.formKey,
        sourcePlugin: ctx.plugin, sourceOrigin: ctx.origin, targetPlugin,
      });
    }),
    // No target plugin needed — the `when` clause on this command's webview/context contribution
    // (package.json) already keeps it absent for an immutable column, matching today's disabled
    // Remove item.
    vscode.commands.registerCommand('modbench.columnHeader.removeOverride', (ctx?: ColumnHeaderContext) => {
      if (!ctx) return;
      broadcastToRecordPanels(recordPanels, {
        type: EXTENSION_TO_WEBVIEW.COLUMN_HEADER_REMOVE_OVERRIDE, formKey: ctx.formKey, plugin: ctx.plugin, origin: ctx.origin,
      });
    }),
    vscode.commands.registerCommand('modbench.columnHeader.addMaster', async (ctx?: ColumnHeaderContext) => {
      if (!ctx) return;
      const newMaster = await pickAddMasterCandidate(repository, ctx.plugin, ctx.masters);
      if (!newMaster) return;
      broadcastToRecordPanels(recordPanels, {
        type: EXTENSION_TO_WEBVIEW.COLUMN_HEADER_ADD_MASTER, formKey: ctx.formKey, plugin: ctx.plugin, origin: ctx.origin, newMaster,
      });
    }),
  ];
}

// #227: Add/Remove/Move Up/Move Down's native `webview/context` menu commands — same
// broadcast-and-self-filter shape as #208's pendingCell.*/#209's columnHeader.* above (see
// messages.ts' ARRAY_* doc comment for why), but simpler than either: there is no async
// extension-host-side work at all (no HTTP, no QuickPick, no confirm dialog) — the whole
// mutation lives in the webview's own React state (onArrayEdit/onArrayAdd, pure since #142), so
// each handler just repackages data-vscode-context's payload and broadcasts it. `data-vscode-
// context`'s presence is the only gate (DiffRow never emits it for a sorted array or an
// immutable column, mirroring #142's original arrayEdit/onArrayAdd gate), so unlike
// columnHeader.removeOverride's `when`-clause-only immutable gate, there's nothing extra to
// check here either.
function registerArrayOpCommands(deps: EditorCommandDeps): vscode.Disposable[] {
  const { recordPanels } = deps;
  return [
    vscode.commands.registerCommand('modbench.array.add', (ctx?: ArrayParentContext) => {
      if (!ctx) return;
      broadcastToRecordPanels(recordPanels, {
        type: EXTENSION_TO_WEBVIEW.ARRAY_ADD, formKey: ctx.formKey, plugin: ctx.plugin, origin: ctx.origin, fieldName: ctx.fieldName,
      });
    }),
    vscode.commands.registerCommand('modbench.array.remove', (ctx?: ArrayElementContext) => {
      if (!ctx) return;
      broadcastToRecordPanels(recordPanels, {
        type: EXTENSION_TO_WEBVIEW.ARRAY_REMOVE, formKey: ctx.formKey, plugin: ctx.plugin, origin: ctx.origin, fieldName: ctx.fieldName, index: ctx.index,
      });
    }),
    vscode.commands.registerCommand('modbench.array.moveUp', (ctx?: ArrayElementContext) => {
      if (!ctx) return;
      broadcastToRecordPanels(recordPanels, {
        type: EXTENSION_TO_WEBVIEW.ARRAY_MOVE_UP, formKey: ctx.formKey, plugin: ctx.plugin, origin: ctx.origin, fieldName: ctx.fieldName, index: ctx.index,
      });
    }),
    vscode.commands.registerCommand('modbench.array.moveDown', (ctx?: ArrayElementContext) => {
      if (!ctx) return;
      broadcastToRecordPanels(recordPanels, {
        type: EXTENSION_TO_WEBVIEW.ARRAY_MOVE_DOWN, formKey: ctx.formKey, plugin: ctx.plugin, origin: ctx.origin, fieldName: ctx.fieldName, index: ctx.index,
      });
    }),
  ];
}

// Issue #231 (review): Set Script Flags/Set Property Flags' own QuickPick choices — VMAD's fixed,
// stable flag vocabulary (the binary format's own enum). Mirrored here rather than imported from
// `webview/src/vmadOps.ts` across the webview/extension-host process boundary (nothing else on
// this side needs that module, and there is no existing precedent for `extension.ts` reaching
// into `webview/src` — see vmadTreeAdapter.ts's own SCRIPT_FLAGS for the webview-side copy, used
// to build a script's read-only Flags row).
const VMAD_SCRIPT_FLAGS = ['Local', 'Inherited', 'Removed', 'InheritedAndRemoved'] as const;
const VMAD_PROP_FLAGS = ['Edited', 'Removed'] as const;

// Issue #231: VMAD's own structural-op commands — same broadcast-and-self-filter shape as
// registerArrayOpCommands above, reached from the "Scripts (VMAD)" wrapper row (Add Script), a
// script row (Remove Script, Add Property, Set Script Flags), or a property row (Remove
// Property, Set Property Flags). Add Script is the one with extension-host-side async work of
// its own (pickScriptNameViaInputBox, the same native input box the pre-#231 webview-triggered
// "Add Script" already used) — a dismissed box (null) broadcasts nothing, same as every other
// cancellable native picker in this file. Add Property collects three fields at once (#229's one
// deliberate webview-modal exception), so its command has nothing to collect itself: it only
// tells the webview which script/plugin to open the dialog for. Set Script/Property Flags each
// run their own native QuickPick here too — a small, static, non-record-dependent enum, the same
// shape Add Script's input box already is — and broadcast nothing at all when dismissed.
function registerVmadOpCommands(deps: EditorCommandDeps): vscode.Disposable[] {
  const { recordPanels } = deps;
  return [
    vscode.commands.registerCommand('modbench.vmad.addScript', async (ctx?: VmadScriptsContext) => {
      if (!ctx) return;
      const name = await pickScriptNameViaInputBox();
      if (name == null) return;
      broadcastToRecordPanels(recordPanels, {
        type: EXTENSION_TO_WEBVIEW.VMAD_ADD_SCRIPT, formKey: ctx.formKey, plugin: ctx.plugin, origin: ctx.origin, name,
      });
    }),
    vscode.commands.registerCommand('modbench.vmad.removeScript', (ctx?: VmadScriptContext) => {
      if (!ctx) return;
      broadcastToRecordPanels(recordPanels, {
        type: EXTENSION_TO_WEBVIEW.VMAD_REMOVE_SCRIPT, formKey: ctx.formKey, plugin: ctx.plugin, origin: ctx.origin, scriptName: ctx.scriptName,
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
        type: EXTENSION_TO_WEBVIEW.VMAD_REMOVE_PROPERTY, formKey: ctx.formKey, plugin: ctx.plugin, origin: ctx.origin,
        scriptName: ctx.scriptName, propName: ctx.propName,
      });
    }),
    // Issue #231 (review): "Seeded with the current value" means the script's own current flag is
    // sorted to the front of the QuickPick's item array — the exact same convention the
    // condition-function picker already uses (showQuickPick has no activeItem option the way
    // QuickPick does), not a new pattern.
    vscode.commands.registerCommand('modbench.vmad.setScriptFlags', async (ctx?: VmadScriptContext) => {
      if (!ctx) return;
      const items = ctx.currentFlags && (VMAD_SCRIPT_FLAGS as readonly string[]).includes(ctx.currentFlags)
        ? [ctx.currentFlags, ...VMAD_SCRIPT_FLAGS.filter(f => f !== ctx.currentFlags)]
        : [...VMAD_SCRIPT_FLAGS];
      const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Script flags' });
      if (!picked) return;
      broadcastToRecordPanels(recordPanels, {
        type: EXTENSION_TO_WEBVIEW.VMAD_SET_SCRIPT_FLAGS, formKey: ctx.formKey, plugin: ctx.plugin, origin: ctx.origin,
        scriptName: ctx.scriptName, flags: picked,
      });
    }),
    // Issue #231 (review): no current-value seed — the read model never carried a real
    // per-property flag even before this ticket (the deleted PropertyFlagsControl's own comment:
    // "set-only, defaults to Edited"), so there is nothing to sort to the front here.
    vscode.commands.registerCommand('modbench.vmad.setPropertyFlags', async (ctx?: VmadPropertyContext) => {
      if (!ctx) return;
      const picked = await vscode.window.showQuickPick([...VMAD_PROP_FLAGS], { placeHolder: 'Property flags' });
      if (!picked) return;
      broadcastToRecordPanels(recordPanels, {
        type: EXTENSION_TO_WEBVIEW.VMAD_SET_PROPERTY_FLAGS, formKey: ctx.formKey, plugin: ctx.plugin, origin: ctx.origin,
        scriptName: ctx.scriptName, propName: ctx.propName, flags: picked,
      });
    }),
  ];
}

interface ModListCoreDeps {
  modListProvider: ModListProvider;
  modlistSource: Mo2ModlistSource;
  updateProfileDescription: () => Promise<void>;
  enterEditing: (progress?: vscode.Progress<{ message?: string }>) => Promise<void>;
  outputChannel: vscode.LogOutputChannel;
}
/** Loadout core commands: refresh, switch profile, filter, launch mEdit. */
function registerModListCoreCommands(deps: ModListCoreDeps): vscode.Disposable[] {
  const { modListProvider, modlistSource, updateProfileDescription, enterEditing, outputChannel } = deps;
  return [
      vscode.commands.registerCommand('modbench.modList.sortDescending', () => {
        modListProvider.toggleSortOrder();
        void vscode.commands.executeCommand('setContext', 'modbench.modList.sortDescending', true);
      }),
      vscode.commands.registerCommand('modbench.modList.sortAscending', () => {
        modListProvider.toggleSortOrder();
        void vscode.commands.executeCommand('setContext', 'modbench.modList.sortDescending', false);
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
      registerFilterBoxCommand(
        'modbench.modList.filter', 'Filter mods…',
        (text, grouping) => modListProvider.setFilter(text, grouping),
        { icon: 'list-tree', label: 'Group by separator' },
      ),
      vscode.commands.registerCommand('modbench.modList.launchMedit', async () => {
        // enterEditing puts chevrons on the merged tree's rows only once the session is
        // loaded (issue #75 / #270) — there is no view mode left to flip (#273). Show
        // progress while the backend spawns and the session loads.
        try {
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'mEdit' },
            (progress) => enterEditing(progress),
          );
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
  dataFolder: Promise<string | undefined>;
  /** The record browser that supplies a plugin row's children (#270). Passed as the composite's
   *  child source and never touched directly here. */
  recordBrowser: PluginTreeProvider;
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
function registerPluginListView(deps: PluginListDeps): { pluginListProvider: PluginListProvider; disposables: vscode.Disposable[] } {
  const { modlistSource, log, outputChannel, reporter, instanceRoot, dataFolder, recordBrowser } = deps;
  const pluginListProvider = new PluginListProvider({ source: modlistSource, log, reporter, instanceRoot, dataFolder });
  const composite = new PluginsTreeComposite<PluginListNode, PluginTreeNode>({
    rows: pluginListProvider,
    children: recordBrowser,
    pluginFileOf,
    // #277 / ADR-0037 AC8: lets the composite reconcile the order-aware badge with session state
    // by master name, instead of two decorations that can disagree.
    orderIssueMastersOf,
  });
  pluginsTree = composite;
  // A backend that dies takes the session with it, and `exitToLoadout` is not on that path — a
  // crash or a lost connection reaches us only as a status change. Without this the rows keep
  // their chevrons and expanding one fetches against a backend that is gone.
  backendManager?.on('status', () => {
    if (!backendManager?.isHealthy) composite.setSession(undefined);
  });
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
    trackRecordSelection(pluginListView),
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
    vscode.commands.registerCommand('modbench.pluginListTree.revealInExplorer', async (node: PluginListNode) => {
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
    }),
    registerFilterBoxCommand('modbench.pluginListTree.filter', 'Filter plugins…', (text) => pluginListProvider.setFilter(text)),
  ] };
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
} {
  const { context, outputChannel } = deps;
  registerDeploymentModeContext(context);
  const loadout = registerLoadoutView({ ...deps, revealLog: () => outputChannel.show(true) });
  registerLoadoutHeaderView({ context, outputChannel, ...loadout });
  return {
    modListProvider: loadout?.modListProvider,
    downloadsProvider: loadout?.downloadsProvider,
    pluginListProvider: loadout?.pluginListProvider,
  };
}

interface LoadoutViewDeps {
  context: vscode.ExtensionContext;
  log: (msg: string) => void;
  outputChannel: vscode.LogOutputChannel;
  revealLog: () => void;
  controller: SessionController;
  changeGroupTreeProvider: PendingChangesTreeProvider;
  /** #270: the record browser the Plugins tree's rows expand into. Threaded from `activate`,
   *  which owns the single instance both plugin trees read through. */
  recordBrowser: PluginTreeProvider;
  /** #270: the plugin files the running session holds, for deciding which rows can expand.
   *  Injected as a getter so the composite's own wiring stays at the composition root. */
  sessionPluginFiles: () => Promise<SessionPluginFiles>;
}
/** Register the Loadout (Mod List) view and its commands. Returns the live
 *  ModListProvider and DownloadsProvider (exposed via activate() for integration
 *  tests), or undefined with a neutral log when no workspace is open, or when the
 *  workspace isn't an MO2 instance (#192 — the Mods view shows welcome content instead). */
function registerLoadoutView(deps: LoadoutViewDeps): { modListProvider: ModListProvider; downloadsProvider: DownloadsProvider; pluginListProvider: PluginListProvider; modlistSource: Mo2ModlistSource; instanceRoot: string; refreshAll: () => void } | undefined {
  const { context, log, outputChannel, revealLog, controller, changeGroupTreeProvider, recordBrowser, sessionPluginFiles } = deps;
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
    // Resolve the game's Data folder ONCE (#78): the single GameDirectory resolver
    // (config override → ini gamePath → autodetect) is kicked off here and its
    // dataFolder threaded to the providers, replacing their per-refresh ini re-reads.
    // Non-blocking (keeps registration synchronous) and never rejects — a null
    // resolution or a misconfigured explicit setting both fold to undefined, so the
    // consumers degrade exactly as before (empty vanilla masters, badges absent).
    const dataFolder: Promise<string | undefined> = resolveGameDirectory(instanceRoot, meditConfig(), makeDetectPaths())
      .then((gd) => gd?.dataFolder)
      .catch((e: unknown) => {
        outputChannel.error(`[extension] resolving the game directory failed: ${e instanceof Error ? e.message : String(e)}`);
        return undefined;
      });
    const modListProvider = new ModListProvider({ source: modlistSource, log, instanceRoot, reporter: modListReporter, dataFolder });
    const { pluginListProvider, disposables: pluginListDisposables } =
      registerPluginListView({ modlistSource, log, outputChannel, reporter: makeReporter(outputChannel, 'pluginList'), instanceRoot, dataFolder, recordBrowser });
    const modListView = vscode.window.createTreeView('modbench.modList', {
      treeDataProvider: modListProvider,
      showCollapseAll: true,
      dragAndDropController: modListProvider,
    });

    const updateProfileDescription = async () => {
      try {
        modListView.description = await modlistSource.getActiveProfile();
      } catch (err) {
        outputChannel.error(`[extension] reading active profile failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    void updateProfileDescription();

    const runModAction = async (logLabel: string, failMessage: string, action: () => Promise<void>) => {
      try {
        await action();
        modListProvider.invalidate();
      } catch (err) {
        outputChannel.error(`[extension] ${logLabel} failed: ${err instanceof Error ? err.message : String(err)}`);
        void vscode.window.showErrorMessage(`Modbench: ${failMessage}`);
      }
    };

    /** Prompt for a mod name, defaulting to the archive/folder basename. */
    const promptModName = (defaultName: string): Thenable<string | undefined> =>
      vscode.window.showInputBox({ prompt: 'Mod name', value: defaultName });

    const warnIfFomod = (name: string, isFomod: boolean): void => {
      if (isFomod)
        void vscode.window.showWarningMessage(
          `Modbench: "${name}" is a FOMOD installer — its files were copied as-is and need manual ` +
            `arrangement (the scripted installer is coming later).`,
        );
    };
    const enterEditing = makeEnterEditing({ instanceRoot, modlistSource, controller, changeGroupTreeProvider, outputChannel, revealLog, sessionPluginFiles });
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
      modListView.onDidChangeCheckboxState((e) => onModCheckboxChanged(e, modListProvider, outputChannel)),
      ...registerModListCoreCommands({ modListProvider, modlistSource, updateProfileDescription, enterEditing, outputChannel }),
      ...registerDeployCommands(instanceRoot, modlistSource, outputChannel),
      registerLaunchCommand(outputChannel),
      ...registerModInstallCommands({ modlistSource, runModAction, promptModName, warnIfFomod }),
      ...registerModContextCommands({ instanceRoot, modlistSource, outputChannel, runModAction }),
      ...registerSeparatorCommands({ modlistSource, runModAction }),
      ...registerOverwriteView(instanceRoot, modListProvider, outputChannel),
      registerModsAutoRegisterWatcher(instanceRoot, modlistSource, modListProvider, outputChannel),
      ...pluginListDisposables,
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
    sessionRunning: () => backendManager?.isHealthy ?? false,
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
  // Every backend lifecycle transition — attach, disconnect, crash, and (since #247) a
  // deliberate stop — moves the session row, so one subscription covers all of them.
  backendManager?.on('status', () => provider.refresh());
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
      registerFilterBoxCommand('modbench.downloads.filter', 'Filter downloads…', (text) => downloadsProvider.setFilter(text)),
      registerDownloadsSortCommand(downloadsProvider),
      ...registerDownloadsHiddenToggleCommands(downloadsProvider),
      ...registerDownloadsSingleRowCommands(instanceRoot, log),
      ...registerDownloadsMultiRowCommands(instanceRoot, log),
    ],
  };
}

interface EnterEditingDeps {
  instanceRoot: string;
  modlistSource: Mo2ModlistSource;
  controller: SessionController;
  changeGroupTreeProvider: PendingChangesTreeProvider;
  outputChannel: vscode.LogOutputChannel;
  /** #270: the plugin files the loaded session holds — read once the session is up, to decide
   *  which rows can expand. */
  sessionPluginFiles: () => Promise<SessionPluginFiles>;
  /** Surface the Modbench output channel so the user can watch the launch steps. */
  revealLog: () => void;
}
type LaunchProgress = vscode.Progress<{ message?: string }>;
/** Build the enter-editing action: spawn/attach the backend and load the active
 *  modlist as a load-explicit session, then reveal the editing view. Also the
 *  crash-restart reload path. `progress` (when launched by the user) is updated
 *  with the plugin count during the long, blocking index step. */
function makeEnterEditing(deps: EnterEditingDeps): (progress?: LaunchProgress) => Promise<void> {
  const { instanceRoot, modlistSource, controller, changeGroupTreeProvider, outputChannel, revealLog, sessionPluginFiles } = deps;
  return async (progress?: LaunchProgress): Promise<void> => {
      revealLog(); // the load can take a while; let the user watch the step log
      const gd = await resolveGameDirectory(instanceRoot, meditConfig(), makeDetectPaths());
      if (!gd) {
        exitToLoadout(); // don't strand the UI in an empty editing view
        void vscode.window.showErrorMessage(
          'Modbench: No game directory found. Set modbench.mods.gameDirectory to your Stock Game Folder or Steam install.',
        );
        return;
      }
      // Spawn/attach the backend and walk the mod tree concurrently — independent
      // work; the health gate is applied after they join.
      progress?.report({ message: 'starting backend…' });
      outputChannel.info('[extension] entering editing: starting backend and building plugin list');
      const [, plugins] = await Promise.all([
        backendManager!.start(),
        buildExplicitPluginsWithOrigin(modlistSource, instanceRoot, gd.dataFolder),
      ]);
      if (!backendManager!.isHealthy) {
        exitToLoadout(); // tear down the half-started backend and reset the view
        void vscode.window.showErrorMessage('Modbench: Backend failed to start — see the Modbench output for details.');
        return;
      }
      // load-explicit is one blocking call that indexes every plugin — the slow part.
      // There's no progress stream, so name the count and warn it can take a while.
      progress?.report({ message: `indexing ${plugins.length} plugins… (this can take a while)` });
      outputChannel.info(`[extension] backend healthy; loading session (${plugins.length} plugins)`);
      const failures = await controller.loadExplicitSession(plugins, gd.dataFolder);
      // #295 AC4: undefined (not `[]`) means the POST itself failed — loadExplicitSession
      // already surfaced the error (ADR-0026 "explicit action failed" tier). The backend's own
      // SessionManager disposes the previous session unconditionally before attempting the new
      // one, so by this point there is truly no session left, not a stale one — the same
      // treatment the two failure returns above give themselves, so this is the third symmetric
      // case rather than a new partial-recovery path. Reading its plugin list or syncing its
      // filter would either throw against a sessionless backend or silently render nothing,
      // neither of which is "the tree honestly says editing is unavailable".
      if (failures === undefined) {
        exitToLoadout();
        return;
      }
      await controller.syncFilterState();
      changeGroupTreeProvider.refresh();
      // #270 / ADR-0035: rows gain chevrons here and nowhere else — this is the moment records
      // become queryable, the same moment #75 gates the editing tree's first fetch on.
      try {
        const session = await sessionPluginFiles();
        // #277 / ADR-0037 AC7: the same failures the toast inside loadExplicitSession already
        // consumed — held here (not re-derived, not a second endpoint) and handed to the tree
        // through the same setSession bundle as everything else the session reports.
        const loadFailures = new Map(failures.map((f) => [f.name ?? '?', f.reason ?? 'Unknown error'] as const));
        pluginsTree?.setSession(session.files, session.readOnly, session.masterIssues, loadFailures);
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
      outputChannel.info('[extension] editing session ready');
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

  const pendingChangesSql = path.join(scriptsPath, 'pending-changes.sql');
  const presetSrc = path.join(__dirname, '..', 'extension', 'scripts', 'pending-changes.sql');
  if (!fs.existsSync(pendingChangesSql) && fs.existsSync(presetSrc))
    fs.copyFileSync(presetSrc, pendingChangesSql);

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
): vscode.Disposable[] {
  const config = meditConfig;
  const detectPaths = makeDetectPaths();

  const reporter = makeReporter(outputChannel, 'deploy');

  const resolveGd = async () => {
    const gd = await resolveGameDirectory(instanceRoot, config(), detectPaths);
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
    const index = buildFileConflictIndex(await modlistSource.readModlist(), instanceRoot);
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

// Issue #230: the extended editor's temp files live under here — one directory for the whole
// session (extendedFieldEditor.ts keys the actual per-field path off it), computed once rather
// than per panel/per open, since it never varies within a run.
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
  // #210: threaded through so the FormKey picker's search (PluginRepository.searchRecords) is
  // available per panel — see the onDidReceiveMessage wiring below for why it's rebuilt per
  // panel/per message rather than folded into the shared routerDeps.
  repository: ApiPluginRepository;
  // #282: kept current at both branches below (reuse-and-retarget, create) — the Referenced By
  // view's whole input, replacing the old showReferencedBy(node) command argument.
  activeRecordTracker: ActiveRecordTracker<vscode.WebviewPanel>;
}

function openRecordPanel(
  context: vscode.ExtensionContext,
  openPanels: Map<string, vscode.WebviewPanel>,
  title: string,
  formKey: string | undefined,
  port: number,
  viewColumn: vscode.ViewColumn = vscode.ViewColumn.One,
  { routerDeps, recordPanels, repository, activeRecordTracker }: OpenRecordPanelDeps,
) {
  if (viewColumn !== vscode.ViewColumn.Beside) {
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

  if (viewColumn !== vscode.ViewColumn.Beside) {
    openPanels.set(RECORD_PANEL_KEY, panel);
    panel.onDidDispose(() => openPanels.delete(RECORD_PANEL_KEY));
  }

  recordPanels.add(panel);
  panel.onDidDispose(() => recordPanels.delete(panel));

  wireActiveRecordTracking(panel, formKey, activeRecordTracker);

  // #210/#211/#212: every *Picker/*Confirm/*Name .reply is bound to this specific panel — the
  // native prompt a request opens only ever exists for the one click that asked, so the reply is
  // never broadcast to recordPanels the way #208/#209's commands are.
  panel.webview.onDidReceiveMessage((msg: unknown) => {
    void routeRecordPanelMessage(msg, {
      ...routerDeps,
      formKeyPicker: { repository, reply: (m) => void panel.webview.postMessage(m) },
      conditionFunctionPicker: { repository, reply: (m) => void panel.webview.postMessage(m) },
      revertGroupConfirm: { reply: (m) => void panel.webview.postMessage(m) },
      addScriptName: { reply: (m) => void panel.webview.postMessage(m) },
      clipboardRead: { reply: (m) => void panel.webview.postMessage(m) },
      // Issue #230: tempRoot/log/reporter are session-static (the same values every panel would
      // get), only `reply` genuinely varies per panel — bundled here anyway, matching every other
      // *Picker/*Confirm/*Name/clipboardRead reconstruction on this object, rather than splitting
      // "static" fields onto routerDeps and "per-panel" fields onto a second bundle.
      extendedFieldEditor: {
        tempRoot: extendedFieldEditorTempRoot,
        reply: (m) => void panel.webview.postMessage(m),
        log: (msg) => routerDeps.channel.debug(msg),
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

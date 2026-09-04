import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { type CompileResult } from './ApiClient';
import { EditingController } from './EditingController';
import { InteriorLoadMoreNode, PluginTreeProvider, RecordTypeNode, RecordNode, PlacedNode } from './PluginTreeProvider';
import { ReferencedByGroupNode, referencedByCopyText, type ReferencedByTreeNode } from './ReferencedByTreeProvider';
import { ActiveRecordTracker } from './ActiveRecordTracker';
import { type CompileTarget } from './compileTarget';
import { offerEslFlagRemoval, type EslFlagRemovalTarget } from './eslFlagRemovalPrompt';
import { ApiPluginRepository, type PluginRepository } from './PluginRepository';
import { trackedModFoldersOf, registerTrackedRepositories, pluginRepositoriesOf } from './trackedRepositories';
import { startExternalChangePolling, gateExternalChangePolling, type OpenMergeEditor } from './externalChangeCoordinator';
import { buildWebviewHtml } from './webviewHtml';
import { EXTENSION_TO_WEBVIEW, type ExtensionToWebview, type ColumnHeaderContext } from './messages';
import { copyTargetPlugins, type CopyGesture } from './copyTargetPlugins';
import { renumberConfirmMessage } from './renumberConfirm';
import { routeRecordPanelMessage, type RouteRecordPanelMessageDeps } from './recordPanelMessageRouter';
import { RecordDecorationProvider } from './RecordDecorationProvider';
import { makeOnRecordEdited } from './onRecordEdited';
import { registerForwarderCommands } from './recordPanelForwarderCommands';
import { makeReporter } from '../reporter';

export interface EditorCommandDeps {
  context: vscode.ExtensionContext;
  openPanels: Map<string, vscode.WebviewPanel>;
  // Every open 'modbench'-viewType record panel — see openRecordPanel's recordPanels param.
  recordPanels: Set<vscode.WebviewPanel>;
  // Which of recordPanels is active, and what FormKey each shows — openRecordPanel keeps
  // this current; the Referenced By view retargets from it, not from a command argument.
  activeRecordTracker: ActiveRecordTracker<vscode.WebviewPanel>;
  port: number;
  treeProvider: PluginTreeProvider;
  controller: EditingController;
  repository: ApiPluginRepository;
  scriptsPath: string;
  // The Referenced By view itself — needed for its Copy command's selection
  // fallback (`.selection`). The provider is not threaded here: nothing in this file retargets
  // it directly (`activate()` wires that to activeRecordTracker once).
  referencedByTreeView: vscode.TreeView<ReferencedByTreeNode>;
  // `modbench.openEditorBeside`'s selection fallback, against the merged Plugins tree. Narrowed
  // to the one cross-context fact this file needs, not the composition root's session object.
  mergedTreeSelection: () => readonly unknown[];
  // The two things a committed field edit redrives (the filter's match map, the plugin's Source
  // Control status) live on the session object, narrowed to callbacks like mergedTreeSelection.
  refreshMatchingPlugins: () => void;
  refreshSourceControlFor: (plugin: string) => void;
  outputChannel: vscode.LogOutputChannel;
}
export function registerEditorCommands(deps: EditorCommandDeps): vscode.Disposable[] {
  return [
    ...registerRecordViewCommands(deps),
    ...registerForwarderCommands(deps.recordPanels),
  ];
}
export function registerRecordViewCommands(deps: EditorCommandDeps): vscode.Disposable[] {
  const {
    context, openPanels, recordPanels, activeRecordTracker, port, treeProvider, controller, scriptsPath,
    referencedByTreeView, outputChannel, mergedTreeSelection,
  } = deps;
  // The *shared* router deps; `formKeyPicker` is rebuilt per panel below, since its reply must
  // reach the one panel that asked. One decoration provider per activation: its lookup reads
  // treeProvider's cache live, so it needs no copy of that state.
  const recordDecorationProvider = new RecordDecorationProvider(
    (plugin, origin, formKey) => treeProvider.workingTreeStateOf(plugin, origin, formKey));
  const routerDeps: RouteRecordPanelMessageDeps = {
    channel: outputChannel,
    // COPY_TO_CLIPBOARD's ADR-0026 surfacing on a failed clipboard write.
    reporter: makeReporter(outputChannel, 'copyToClipboard'),
    // ADR-0041: the single write path, plus the broadcast telling every panel showing this record
    // to re-read — broadcast, not a reply, since the record can be open in several panels.
    repository: deps.repository,
    onRecordEdited: makeOnRecordEdited(
      treeProvider, recordDecorationProvider, recordPanels,
      () => { deps.refreshMatchingPlugins(); },
      (plugin) => deps.refreshSourceControlFor(plugin),
    ),
    // Placeholders — the onDidReceiveMessage wiring below overrides both per panel every call.
    formKeyPicker: undefined,
    extendedFieldEditor: undefined,
  };
  return [
    vscode.window.registerFileDecorationProvider(recordDecorationProvider),
    vscode.commands.registerCommand('modbench.openEditor', (args?: { formKey?: string; label?: string }) => {
      openRecordPanel(context, openPanels, args?.label ?? args?.formKey ?? 'mEdit', args?.formKey, port,
        vscode.ViewColumn.One, { routerDeps, recordPanels, activeRecordTracker, singleton: true });
    }),
    // A named "Open to the Side" (ADR-0034), not a right-click side effect. `item`/`allSelected`
    // mirror VS Code's view/item/context invocation shape, falling back to the tree's current
    // selection when neither is supplied.
    vscode.commands.registerCommand('modbench.openEditorBeside',
      (item?: RecordNode | PlacedNode | ReferencedByGroupNode | { formKey?: string; label?: string },
        allSelected?: unknown[]) => {
        const selection = mergedTreeSelection();
        const nodes: readonly unknown[] = allSelected?.length ? allSelected
          : selection.length ? selection
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
    // Retargets nothing — the view follows activeRecordTracker on its own.
    // Kept as a Command Palette reveal-this-view convenience; no menu invokes this.
    vscode.commands.registerCommand('modbench.showReferencedBy',
      () => vscode.commands.executeCommand('modbench.referencedByTree.focus')),
    // xEdit parity (xeMainForm.pas's CopyInto). One command behind both a keybinding and a menu
    // entry: ADR-0034's "no action reachable two ways" bars redundant affordances, not this.
    vscode.commands.registerCommand('modbench.referencedByTree.copy',
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
      }),
  ];
}
// Apart from registerRecordViewCommands because select/apply/clear the active SQL filter is one
// concern, distinct from the record-panel and reveal commands.
export function registerFilterCommands(scriptsPath: string, controller: EditingController): vscode.Disposable[] {
  return [
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
  ];
}
/** ADR-0034: xEdit hosts Add/Remove/Change FormID in its tree's context menu, not the grid, and
 *  the titles match its captions exactly. No ambient fallback is worth a QuickPick, so all three
 *  are palette-gated. */
export function registerRecordLifecycleCommands(
  controller: EditingController, repository: PluginRepository, outputChannel: vscode.LogOutputChannel,
): vscode.Disposable[] {
  const resolveOriginOrReport = makeResolveOriginOrReport(controller, outputChannel);

  return [
    // xEdit's own "Add": no prompt — a blank record appears immediately and is named afterward
    // by editing its EditorID, matching xEdit's own gesture.
    vscode.commands.registerCommand('modbench.record.create', async (node?: RecordTypeNode) => {
      if (node?.kind !== 'recordType') return;
      const origin = await resolveOriginOrReport({ origin: node.origin, pluginName: node.plugin });
      if (!origin) return;

      const formKey = await controller.createRecord(
        node.plugin, origin, node.recordType, undefined, undefined,
        message => promptEslFlagRemoval({ name: node.plugin, origin }, message, 'Create the Record', repository),
      );
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

    // xEdit's own "Change FormID": a native InputBox prefilled with the next-free suggestion, so
    // accepting the default is one Enter; typing over it is validated server-side.
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

      // A renumber with referencers cascades behind one up-front confirm stating the blast radius.
      // A fetch failure degrades to a confirm with no counts: the backend re-checks referencers
      // regardless of what this preview said.
      let confirmMessage: string | null;
      try {
        confirmMessage = renumberConfirmMessage(
          node.record.formKey, input || suggested || '(next free)', await repository.getReferences(node.record.formKey));
      } catch (e) {
        outputChannel.warn(`[extension] record.renumber could not fetch referencers for the confirm: ${e instanceof Error ? e.message : String(e)}`);
        confirmMessage = `Change FormID of ${node.record.formKey}? Its references could not be counted — ` +
          'every referencing record in a tracked plugin will be updated with it.';
      }
      if (confirmMessage !== null) {
        const choice = await vscode.window.showWarningMessage(confirmMessage, { modal: true }, 'Change FormID');
        if (choice !== 'Change FormID') return;
      }

      const newFormKey = await controller.renumberRecord(node.record.formKey, node.record.plugin, origin, input || undefined);
      if (newFormKey) void vscode.window.showInformationMessage(`Modbench: Renumbered to ${newFormKey}.`);
    }),
  ];
}
/** A node's own `origin` when the row already carries it (ADR-0036), else
 *  `controller.resolveOrigin`; reports and returns undefined when neither answers. */
export function makeResolveOriginOrReport(
  controller: EditingController, outputChannel: vscode.LogOutputChannel,
): (node: { origin?: string; pluginName: string }) => Promise<string | undefined> {
  const reporter = makeReporter(outputChannel, 'recordLifecycle');
  return async (node) => {
    const origin = node.origin ?? await controller.resolveOrigin(node.pluginName);
    if (!origin) {
      reporter.report('error', `Could not resolve which mod "${node.pluginName}" belongs to.`);
    }
    return origin;
  };
}
/** A `RecordNode` names the record through `record.plugin`, a `ColumnHeaderContext` directly.
 *  Undefined for anything else, so a stale invocation resolves to nothing rather than throwing. */
export function recordCopyIdentity(
  arg: RecordNode | ColumnHeaderContext | undefined,
): { formKey: string; plugin: string; origin?: string } | undefined {
  if (!arg) return undefined;
  if ('kind' in arg) return arg.kind === 'record' ? { formKey: arg.record.formKey, plugin: arg.record.plugin, origin: arg.origin } : undefined;
  return { formKey: arg.formKey, plugin: arg.plugin, origin: arg.origin };
}
/** Returns the picked `PluginMetadata`, not just its name, so the caller reads `.origin` off it
 *  instead of a second round trip. Either call rejecting is caught wholesale: no fallback tier
 *  remains below this step. */
export async function pickCopyDestination(
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
    // gesture goes in `detail`, not `message` — it's context for the Output channel, not
    // something the toast (already carrying `detail`) needs to repeat.
    makeReporter(outputChannel, 'pickCopyDestination').report('error', `Could not look up destination plugins: ${detail}`, gesture);
    return undefined;
  }
}
/** No confirmation modal: xEdit's CopyInto asks nothing before an override copy, and Copy as New
 *  Record prompts for neither an EditorID nor a FormKey — land immediately, rename via the grid. */
export async function runCopyRecordCommand(
  gesture: CopyGesture, arg: RecordNode | ColumnHeaderContext | undefined,
  controller: EditingController, repository: PluginRepository,
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
      identity.formKey, identity.plugin, sourceOrigin, destination.name, destination.origin, undefined,
      message => promptEslFlagRemoval(destination, message, 'Copy the Record', repository),
    );
    if (newFormKey) void vscode.window.showInformationMessage(`Modbench: Copied as ${newFormKey} into ${destination.name}.`);
  }
}
/** The one shape this extension needs from a `vscode.git` `Repository` — just `status()`,
 *  which forces the repository to re-check the working tree, the same effect the SCM panel's own
 *  manual Refresh button has. */
export interface MinimalRepository {
  status(): Thenable<unknown>;
}
// Deliberately not the full upstream `git.d.ts`, just the members called, so nothing here can
// drift against an API this extension otherwise never touches. `openRepository` resolves `null`
// for "declined to open".
interface MinimalGitApi {
  openRepository(uri: vscode.Uri): Thenable<MinimalRepository | null>;
}
interface GitExtensionExports {
  getAPI(version: 1): MinimalGitApi;
}

/** ADR-0041: one `openRepository` per distinct tracked folder, so each shows its own native
 *  Source Control group. A silent, logged no-op when `vscode.git` is unavailable: this only
 *  narrows the native UI, never blocks reading or editing. */
export async function registerHeldTrackedRepositories(
  repository: ApiPluginRepository, outputChannel: vscode.LogOutputChannel,
  setPluginRepositories: (repos: Map<string, MinimalRepository>) => void,
): Promise<void> {
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
    const folderRepositories = await registerTrackedRepositories(
      (folder) => Promise.resolve(gitApi.openRepository(vscode.Uri.file(folder))), folders);
    setPluginRepositories(pluginRepositoriesOf(plugins, folderRepositories));
  } catch (err) {
    outputChannel.error(`[extension] registering tracked repositories with vscode.git failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** `Repository.status()`, the same effect the SCM panel's Refresh button has, fired from the
 *  edit rather than waiting on the native watcher. A plugin with no handle is a silent no-op; a
 *  rejected `status()` is logged, never surfaced. */
export function refreshSourceControlFor(
  pluginRepositories: Map<string, MinimalRepository> | undefined, plugin: string, outputChannel: vscode.LogOutputChannel,
): void {
  const repo = pluginRepositories?.get(plugin);
  if (!repo) return;
  void repo.status().then(undefined, (err: unknown) => {
    outputChannel.error(`[extension] refreshing Source Control status for ${plugin} failed: ${err instanceof Error ? err.message : String(err)}`);
  });
}

/** Gated on the backend's health signal, since the poller has no backend to answer it until a
 *  spawn succeeds. No disposable to register: Close mEdit and `deactivate()` both emit 'stopped',
 *  which this reacts to like any other transition. */
export function wireExternalChangePolling(
  repository: PluginRepository, controller: EditingController, outputChannel: vscode.LogOutputChannel,
  onBackendStatusChange: (cb: () => void) => void, isBackendHealthy: () => boolean,
): void {
  gateExternalChangePolling({
    onBackendStatusChange,
    isBackendHealthy,
    // Polls `GET /plugins/external-changes/status` (fed by both the backend's live watcher and
    // its load-time hash check) and runs the one dialog, sequentially, for whatever it finds.
    startPolling: () => {
      // `log` is a compat shim (defaults to .info) for modules taking a flat `(msg) => void`,
      // built here at the boundary so the flat shape stops at the collaborator that needs it.
      const log = (msg: string) => outputChannel.info(msg);
      return startExternalChangePolling({
        repository,
        controller,
        showDialog: (message, options, ...buttons) => Promise.resolve(vscode.window.showWarningMessage(message, options, ...buttons)),
        showRebaseOffer: (message, ...buttons) => Promise.resolve(vscode.window.showInformationMessage(message, ...buttons)),
        openMergeEditor: makeMergeEditorOpener(repository, outputChannel),
        log,
      });
    },
  });
}

/** Resolved fresh per call rather than bound to one origin: the dialog-driven path has no single
 *  resolved origin in scope, since several repositories can be mid-answer at once. `vscode.open`
 *  is git's own merge-editor gesture, scripted. */
export function makeMergeEditorOpener(repository: PluginRepository, outputChannel: vscode.LogOutputChannel): OpenMergeEditor {
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

export function reportCompileTargetError(outputChannel: vscode.LogOutputChannel, command: string, message: string): void {
  makeReporter(outputChannel, command).report('error', message);
}

/** `EditingController.compile` already surfaces a transport failure itself (`null`), so this has
 *  nothing to report in that case. Nothing re-reads `GET /plugins` after a compile: a compiled
 *  binary changes only bytes on disk. */
export async function compileAndReport(
  controller: EditingController, diagnostics: vscode.DiagnosticCollection,
  target: CompileTarget, atRef: string | undefined,
  repository: PluginRepository,
): Promise<void> {
  const result = await controller.compile(target.name, target.origin, atRef);
  if (!result) return;

  publishCompileDiagnostics(diagnostics, target.origin, result);

  const refSuffix = atRef ? ` at "${atRef}"` : '';
  if (!result.succeeded) {
    if (result.eslContradiction
        && await promptEslFlagRemoval(target, result.refusalReason ?? '', 'Compile', repository)) {
      await compileAndReport(controller, diagnostics, target, atRef, repository);
      return;
    }
    void vscode.window.showErrorMessage(`Modbench: Could not compile "${target.name}"${refSuffix} — ${result.refusalReason}`);
    return;
  }
  void vscode.window.showInformationMessage(
    result.diagnostics.length > 0
      ? `Modbench: Compiled "${target.name}"${refSuffix} — ${result.diagnostics.length} diagnostic(s), see Problems panel.`
      : `Modbench: Compiled "${target.name}"${refSuffix}.`,
  );
}

// Binds `offerEslFlagRemoval` to `vscode.window`; the core stays `vscode`-free and testable.
async function promptEslFlagRemoval(
  target: EslFlagRemovalTarget, refusalReason: string, verb: string, repository: PluginRepository,
): Promise<boolean> {
  return offerEslFlagRemoval(
    target, refusalReason, verb, repository,
    (message, options, ...items) => vscode.window.showWarningMessage(message, options, ...items),
    message => void vscode.window.showErrorMessage(message),
  );
}

/** Replaces whatever this plugin's source files held from the last compile — never additive, or
 *  a fixed diagnostic would survive forever. Grouped by file, since a diagnostic names its
 *  record's field, not a line this text format defines. */
export function publishCompileDiagnostics(collection: vscode.DiagnosticCollection, origin: string, result: CompileResult): void {
  const instanceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!instanceRoot) return;
  const modFolder = path.join(instanceRoot, 'mods', origin);

  // Clear every URI this collection holds under this folder before republishing —
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


export const RECORD_PANEL_KEY = '__record_view__';
// The temp directory every extended-editor tab writes under —
// load order-static (the same value every panel gets), so it lives at module scope rather than in
// any per-panel bundle.
export const extendedFieldEditorTempRoot = path.join(os.tmpdir(), 'modbench-medit-fields');
// Bundled as one trailing param since these travel together as one panel-wiring concern.
// `recordPanels` is every open panel, main and Beside alike: broadcasts post to all and let each
// self-filter rather than picking "the right one".
export interface OpenRecordPanelDeps {
  routerDeps: RouteRecordPanelMessageDeps;
  recordPanels: Set<vscode.WebviewPanel>;
  // Kept current at both branches below (reuse-and-retarget, create) — the Referenced By
  // view's whole input.
  activeRecordTracker: ActiveRecordTracker<vscode.WebviewPanel>;
  // Deliberately independent of `viewColumn`: a batched Beside open's 2nd..Nth panel needs a
  // concrete resolved column while still being non-retargeting, so `viewColumn !== Beside` cannot
  // stand in for "is this the singleton".
  singleton: boolean;
}
export function openRecordPanel(
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
      // setFormKey before setActivePanel so a genuinely new record fires exactly once,
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

  // FormKey is recorded before the panel is declared active, so a new panel fires the Referenced
  // By retarget exactly once, already carrying it. onDidChangeViewState announces only *gaining*
  // focus: losing it is another panel's event, or removePanel's job.
  if (formKey) activeRecordTracker.setFormKey(panel, formKey);
  activeRecordTracker.setActivePanel(panel);
  panel.onDidChangeViewState(() => {
    if (panel.active) activeRecordTracker.setActivePanel(panel);
  });
  panel.onDidDispose(() => activeRecordTracker.removePanel(panel));

  panel.webview.onDidReceiveMessage((msg: unknown) => {
    // Every reply must reach the one panel that asked, never a broadcast; `routerDeps` is shared
    // across panels, so these per-panel fields are rebuilt with the panel this closure holds.
    const reply = (m: ExtensionToWebview) => { void panel.webview.postMessage(m); };
    void routeRecordPanelMessage(msg, {
      ...routerDeps,
      formKeyPicker: { repository: routerDeps.repository, reply },
      // tempRoot/log/reporter are load order-static (the same values every panel would
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
// Whichever of the three row shapes duck-types, resolved to the (formKey, label) pair
// openRecordPanel needs. `'kind' in node` rather than `instanceof`, so a test can use plain
// object literals shaped like the real tree nodes.
export function recordOpenIdentity(node: unknown): { formKey: string; label: string } | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const n = node as { kind?: string; record?: { formKey?: string }; placed?: { formKey?: string };
    formKey?: string; label?: unknown };
  const formKey = 'kind' in n
    ? n.kind === 'record' ? n.record?.formKey : n.kind === 'placed' ? n.placed?.formKey : undefined
    : n.formKey;
  if (!formKey) return undefined;
  return { formKey, label: typeof n.label === 'string' ? n.label : formKey };
}
// `ViewColumn.Beside` resolves once: the first panel created becomes the active editor, so a
// second Beside call would cascade a new column per record. Not `panel.viewColumn` — that getter
// is still undefined synchronously after `createWebviewPanel` returns.
export function openBesideRecordPanels(
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

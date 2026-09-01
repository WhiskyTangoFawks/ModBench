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
import { ApiPluginRepository, type PluginRepository } from './PluginRepository';
import { trackedModFoldersOf, registerTrackedRepositories, pluginRepositoriesOf } from './trackedRepositories';
import { startExternalChangePolling, gateExternalChangePolling, type OpenMergeEditor } from './externalChangeCoordinator';
import { buildWebviewHtml } from './webviewHtml';
import { EXTENSION_TO_WEBVIEW, type ExtensionToWebview, type VmadScriptsContext, type VmadScriptContext, type VmadPropertyContext, type ColumnHeaderContext } from './messages';
import { copyTargetPlugins, type CopyGesture } from './copyTargetPlugins';
import { routeRecordPanelMessage, pickScriptNameViaInputBox, type RouteRecordPanelMessageDeps } from './recordPanelMessageRouter';
import { RecordDecorationProvider } from './RecordDecorationProvider';
import { broadcastToRecordPanels, makeOnRecordEdited } from './onRecordEdited';
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
  // `modbench.openEditorBeside`'s own selection fallback (below), against the merged Plugins
  // tree instead of Referenced By's — narrow rather than the composition root's own session
  // object, since the merged tree's current selection is the one cross-context fact this file
  // needs, not the tree/sync/backend it's built from.
  mergedTreeSelection: () => readonly unknown[];
  // ADR-0035 amending ADR-0018 / ADR-0041: the two things a committed field edit has to redrive
  // (the record filter's match map, the plugin's own Source Control status) both live on the
  // composition root's session object — narrowed to callbacks for the same reason
  // mergedTreeSelection is, just above.
  refreshMatchingPlugins: () => void;
  refreshSourceControlFor: (plugin: string) => void;
  outputChannel: vscode.LogOutputChannel;
}
/** Editor-side commands, grouped by what they belong to: the record view/navigation/filter
 *  commands, the record panel's own message-forwarded commands, and VMAD's host-resolved prompts
 *  (Add Script, Set Script/Property Flags) — three distinct concerns under the one webview
 *  surface, named here rather than left as an unlabeled flat list. */
export function registerEditorCommands(deps: EditorCommandDeps): vscode.Disposable[] {
  return [
    ...registerRecordViewCommands(deps),
    ...registerForwarderCommands(deps.recordPanels),
    ...registerVmadPromptCommands(deps.recordPanels),
  ];
}
// Set Script Flags/Set Property Flags' own QuickPick choices — VMAD's fixed,
// stable flag vocabulary (the binary format's own enum, VmadCodec.cs's ScriptEntry.Flag/
// ScriptProperty.Flag). Mirrored here rather than imported from webview/src/vmadOps.ts across the
// webview/extension-host process boundary (nothing else on this side needs that module).
export const VMAD_SCRIPT_FLAGS = ['Local', 'Inherited', 'Removed', 'InheritedAndRemoved'] as const;
export const VMAD_PROP_FLAGS = ['Edited', 'Removed'] as const;
// The VMAD commands that resolve something host-side (a native input box or QuickPick) before
// there is a message to build, so they can't live in recordPanelForwarderCommands.ts's own
// table alongside their sibling VMAD commands (Remove Script, Add Property, Remove Property —
// all pure forwards, moved there). Reached from the "Scripts (VMAD)" wrapper row (Add Script), a
// script row (Set Script Flags), or a property row (Set Property Flags). Add Script needs its own
// native input box (pickScriptNameViaInputBox — no round trip through the webview) since there is
// no existing row to right-click for a script that doesn't exist yet. Set Script/Property Flags
// run their own native QuickPick here, seeded (script only — no per-property read model carries a
// current flag) the same way the condition-function picker sorts its own seed to the front.
export function registerVmadPromptCommands(recordPanels: Set<vscode.WebviewPanel>): vscode.Disposable[] {
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
    // "Seeded with the current value" means the script's own current flag is
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
    // No current-value seed — VmadPropertyContext (messages.ts) carries none;
    // the read model has never surfaced a per-property flag.
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
/** Record view/navigation + filter commands. */
export function registerRecordViewCommands(deps: EditorCommandDeps): vscode.Disposable[] {
  const {
    context, openPanels, recordPanels, activeRecordTracker, port, treeProvider, controller, scriptsPath,
    referencedByTreeView, outputChannel, mergedTreeSelection,
  } = deps;
  // The *shared* part of the router deps; `formKeyPicker` itself
  // is rebuilt per panel at the onDidReceiveMessage call site below, since its reply must reach
  // the one panel that asked, never a broadcast.
  // One provider per extension activation (not per panel/command) — its lookup reads
  // treeProvider's own cache live, so it never needs its own copy of the same state.
  const recordDecorationProvider = new RecordDecorationProvider(
    (plugin, origin, formKey) => treeProvider.workingTreeStateOf(plugin, origin, formKey));
  const routerDeps: RouteRecordPanelMessageDeps = {
    channel: outputChannel,
    // COPY_TO_CLIPBOARD's ADR-0026 surfacing on a failed clipboard write.
    reporter: makeReporter(outputChannel, 'copyToClipboard'),
    // ADR-0041: the single write path, and the broadcast that tells every open panel showing
    // this record to re-read. Broadcast rather than replying to the one panel that asked: the same
    // record can be open in more than one panel (openEditorBeside), and all of them are now stale.
    repository: deps.repository,
    onRecordEdited: makeOnRecordEdited(
      treeProvider, recordDecorationProvider, recordPanels,
      () => { deps.refreshMatchingPlugins(); },
      (plugin) => deps.refreshSourceControlFor(plugin),
    ),
    // Placeholders — the onDidReceiveMessage wiring below overrides all three per panel every call.
    formKeyPicker: undefined,
    conditionFunctionPicker: undefined,
    extendedFieldEditor: undefined,
  };
  return [
    vscode.window.registerFileDecorationProvider(recordDecorationProvider),
    vscode.commands.registerCommand('modbench.openEditor', (args?: { formKey?: string; label?: string }) => {
      openRecordPanel(context, openPanels, args?.label ?? args?.formKey ?? 'mEdit', args?.formKey, port,
        vscode.ViewColumn.One, { routerDeps, recordPanels, activeRecordTracker, singleton: true });
    }),
    // Referenced By's named "Open to the Side" (ADR-0034), not a right-click side
    // effect — also reachable from the Plugins tree's record/placed-reference rows (single or
    // multi-selected). `item`/`allSelected` mirror VS Code's own view/item/context invocation shape
    // (clicked, selected[]), falling back to the Plugins tree's own current selection when neither
    // is supplied (e.g. Command Palette) — same fallback chain modbench.referencedByTree.copy
    // already uses, just against pluginsTreeView instead of referencedByTreeView.
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
    // The Referenced By view's own Copy. xEdit parity (xeMainForm.pas's CopyInto) — a
    // keybinding (Ctrl+C while focused) and a view/item/context entry both invoke this one command
    // (package.json), the same "keybinding + menu, one command" shape modbench.deleteRecord already
    // uses; ADR-0034's "no action reachable two ways" is about redundant *affordances* for one action
    // (e.g. an inline button duplicating a menu item), not a command having both a keybinding and a
    // menu entry. Selection resolution mirrors modbench.deleteRecord: the multi-select array VS Code
    // passes when several rows are selected, else the view's own current selection, else the single
    // right-clicked node.
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
// modbench.setFilter/setFilterFromDocument/clearFilter — kept apart from
// registerRecordViewCommands because the three commands are one concern (select/apply/clear the
// active SQL filter), distinct from the record-panel and reveal commands that dominate the rest
// of that function.
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
/** The three lifecycle gestures — create, delete, renumber — as Plugins-tree row commands on
 *  the record browser (ADR-0034: xEdit hosts Add/Remove/Change FormID in its own tree's context
 *  menu, not the grid — this is the tree, not the record editor's field grid). Titled to match
 *  xEdit's own captions exactly ("Add" / "Remove" / "Change FormID…", `xeMainForm.dfm`'s
 *  `mniNavAdd`/`mniNavRemove`/`mniNavChangeFormID`).
 *
 *  Each resolves the clicked row's origin the same way `registerTrackCommand` does (a node's own
 *  `origin` when the row already carries it, else `controller.resolveOrigin` — undefined means an
 *  ordinary load-order plugin, per ADR-0036) — there is no ambient fallback worth a QuickPick, which
 *  is why all three are palette-gated (`packageJson.test.ts`'s `PALETTE_GATED`). */
export function registerRecordLifecycleCommands(
  controller: EditingController, repository: PluginRepository, outputChannel: vscode.LogOutputChannel,
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
/** Shared by `registerRecordLifecycleCommands` here and by `registerPluginRowCommands`
 *  (extension.ts, for the record copy commands it registers inline) — a node's
 *  own `origin` when the row already carries it (ADR-0036), else `controller.resolveOrigin`;
 *  reports and returns undefined when neither answers (there is no ambient fallback worth a
 *  QuickPick, which is why every command that needs this is palette-gated). */
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
/** The plugins-tree row and column-header entry points' shared identity — a
 *  `RecordNode` names it via its own `record.plugin`, a `ColumnHeaderContext` (the header's
 *  `data-vscode-context` payload) names it directly. Undefined for anything else (a `RecordNode`
 *  whose `kind` isn't `'record'` — the command is only ever contributed on a record row, but a
 *  stale/mistyped invocation should still resolve to nothing rather than throw). */
export function recordCopyIdentity(
  arg: RecordNode | ColumnHeaderContext | undefined,
): { formKey: string; plugin: string; origin?: string } | undefined {
  if (!arg) return undefined;
  if ('kind' in arg) return arg.kind === 'record' ? { formKey: arg.record.formKey, plugin: arg.record.plugin, origin: arg.origin } : undefined;
  return { formKey: arg.formKey, plugin: arg.plugin, origin: arg.origin };
}
/** The destination QuickPick both copy commands share — candidates are
 *  `copyTargetPlugins`' own gesture-aware filter (immutable always excluded; every plugin already
 *  carrying the record excluded too, but only for 'copy-as-override' — xEdit parity,
 *  xeMainForm.pas:3023-3042). No "New Plugin…" entry: "copy into
 *  a new file" is out of scope. Returns the picked `PluginMetadata` (not just its name) so
 *  the caller reads `.origin` straight off it — a second `resolveOrigin` round trip for the
 *  destination would be redundant, `repository.getPlugins()` already answers it.
 *
 *  Unlike `resolveOriginOrReport`'s call above it in `runCopyRecordCommand` (which the
 *  invoking row's own carried `origin` usually lets it skip entirely), this step's two repository
 *  calls are unconditional — the real exposure window is the backend dying after the copy
 *  surfaces (a record row, or the record-header webview) have already rendered, which needs a
 *  live load order and so isn't reachable pre-launch. Either awaited call rejecting is deliberately
 *  caught wholesale — this destination-picking step has no further fallback tier below it, the
 *  same "no tier left, so report and resolve to no target" posture `resolveCompileTarget`'s own
 *  `pickPlugin` tier takes — and any rejection gets the same treatment, not just a
 *  transport failure, since nothing past this point can tell the two apart usefully. */
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
/** The shared body behind both `modbench.record.copyAsOverride`/`copyAsNewRecord` —
 *  resolve which record was right-clicked and from where, pick a destination, call the matching
 *  `EditingController` method, toast on success. No confirmation modal (xEdit's own CopyInto asks
 *  nothing before an override copy, only before an EditorID-changing copy-as-new — and Copy as New
 *  Record here prompts for neither an EditorID nor a FormKey, the same "land immediately, rename
 *  via the grid afterward" posture `record.create` already established for a blank creation). */
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
      identity.formKey, identity.plugin, sourceOrigin, destination.name, destination.origin,
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
/** The one shape this extension needs from `vscode.git`'s exported API (ADR-0041: "the native git
 *  UI is the review surface") — deliberately not the full upstream `git.d.ts`, just the members
 *  actually called, so there is nothing here to drift out of sync with an API surface this
 *  extension otherwise never touches. `openRepository` resolves `null` — the real API's own
 *  answer for "declined to open"; the resolved handle is retained by the caller. */
interface MinimalGitApi {
  openRepository(uri: vscode.Uri): Thenable<MinimalRepository | null>;
}
interface GitExtensionExports {
  getAPI(version: 1): MinimalGitApi;
}

/** ADR-0041: one `openRepository` per distinct tracked mod folder, so each shows its own
 *  native Source Control group — re-run whenever the load order becomes newly readable
 *  (`notifyConflictsComputed`'s own call site) and immediately after a successful Track, so a
 *  freshly tracked repo appears without waiting for the next activation. Silent no-op (logged, not
 *  surfaced) when `vscode.git` isn't installed/enabled: this only ever narrows the native UI,
 *  never blocks reading or editing.
 *
 *  #628: narrowed to a setter callback rather than the composition root's session object — this
 *  is Editing-side git-tracking logic that only ever needs to hand its result somewhere, never
 *  to read or own the session itself, the same pattern the four EditorCommandDeps callbacks
 *  already use. */
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

/** Prompts the edited plugin's own repository to re-check its working tree —
 *  `Repository.status()`, the same effect the SCM panel's manual Refresh button has, fired
 *  automatically from `onRecordEdited` instead of waiting on it (or on the native watcher, which
 *  is what left the panel needing that click in the first place). A plugin with no tracked
 *  repository handle (never tracked, or Source Control unavailable) is a silent no-op, same
 *  posture as `registerHeldTrackedRepositories`'s own gates: this only ever narrows the native
 *  UI, never blocks the edit that already succeeded. A rejected `status()` is logged, not
 *  surfaced — a refresh failing must never read as the edit itself having failed.
 *
 *  #628: takes the match map's current value directly rather than the session object — the
 *  caller reads `session.pluginRepositories` fresh at its own call site, so this never holds a
 *  stale reference across the map's own wholesale rebuilds. */
export function refreshSourceControlFor(
  pluginRepositories: Map<string, MinimalRepository> | undefined, plugin: string, outputChannel: vscode.LogOutputChannel,
): void {
  const repo = pluginRepositories?.get(plugin);
  if (!repo) return;
  void repo.status().then(undefined, (err: unknown) => {
    outputChannel.error(`[extension] refreshing Source Control status for ${plugin} failed: ${err instanceof Error ? err.message : String(err)}`);
  });
}

/** The poller has no backend to answer it until Launch mEdit's spawn succeeds — gated on
 *  BackendManager's own 'status'/isHealthy signal, the same idiom `clearTreeWhenBackendDies`
 *  (extension.ts) already reacts to. No disposable to register: a deliberate Close mEdit and
 *  `deactivate()` (`backendManager.dispose()`) both already emit 'stopped', which this reacts to
 *  like any other transition.
 *
 *  #628: narrowed to the same two callbacks `gateExternalChangePolling` itself already wants,
 *  rather than the composition root's session object — this function only ever asks the
 *  backend's own health signal, never reads or owns anything else on the session. */
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
      // `log` is a compat shim (defaults to .info) for modules taking a flat `(msg) => void` —
      // constructed here, at the boundary, rather than threaded in as its own parameter alongside
      // outputChannel (#628: finishing the reporter migration means the flat shape stops at the
      // collaborator that still needs it, not one level higher).
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

/** The {@link OpenMergeEditor} every rebase caller shares — resolves `origin`'s mod folder from any
 *  plugin already known to share it, then opens the conflicted path inside it. VS Code's built-in
 *  git extension shows its own 3-way merge editor for a file it recognizes as conflicted in a
 *  tracked repo (confirmed against the local vscode-docs clone's 1.70 release notes: "The merge
 *  editor can be opened by clicking on a conflicting file in the Source Control view" — `vscode.
 *  open` is that same gesture, scripted). Resolved fresh per call rather than pre-bound to one
 *  origin: the dialog-driven path (unlike the standalone command) has no single already-resolved
 *  origin in scope, since more than one repo can be mid-answer at once. */
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

/** The shared tail both compile commands share once they have a target: call through
 *  `EditingController.compile`, publish diagnostics, and report the one of two outcomes
 *  (`CompileResult.succeeded`) the user got. `EditingController.compile` already surfaces a
 *  transport/HTTP failure itself (`null`), so this has nothing to report in that case.
 *
 *  Nothing here re-reads `GET /plugins` after a successful compile — `EditingController.compile`'s
 *  own doc comment is why: a compiled binary changes nothing that endpoint reports (masters, load
 *  order, record content), only bytes on disk. */
export async function compileAndReport(
  controller: EditingController, diagnostics: vscode.DiagnosticCollection,
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
export function publishCompileDiagnostics(collection: vscode.DiagnosticCollection, origin: string, result: CompileResult): void {
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


export const RECORD_PANEL_KEY = '__record_view__';
// The temp directory every extended-editor tab writes under —
// load order-static (the same value every panel gets), so it lives at module scope rather than in
// any per-panel bundle.
export const extendedFieldEditorTempRoot = path.join(os.tmpdir(), 'modbench-medit-fields');
// Bundled as one trailing param (not two/three) since these travel together as one
// panel-wiring concern — unpacking them into separate positional params only to repack them into
// this same shape below would add a step with no reader benefit. recordPanels is every
// open 'modbench'-viewType panel (main *and* any "Beside" one — see modbench.openEditorBeside
// above); broadcasting commands post to every panel
// in it and let each one self-filter (see RecordPanel.tsx) rather than picking "the right one"
// here.
export interface OpenRecordPanelDeps {
  routerDeps: RouteRecordPanelMessageDeps;
  recordPanels: Set<vscode.WebviewPanel>;
  // Kept current at both branches below (reuse-and-retarget, create) — the Referenced By
  // view's whole input.
  activeRecordTracker: ActiveRecordTracker<vscode.WebviewPanel>;
  // Whether this open should reuse/retarget the singleton RECORD_PANEL_KEY panel (plain
  // "Open"/"Compare") or always create a fresh, non-retargeting panel ("Open Editor to the Side",
  // single or batched). Deliberately independent of `viewColumn` below — a batched Beside open's
  // 2nd..Nth panel needs a concrete resolved ViewColumn (not the Beside sentinel, see
  // openBesideRecordPanels) while still being non-retargeting, so `viewColumn !== Beside` cannot
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

  // Wires the freshly created panel into activeRecordTracker. FormKey is recorded before the
  // panel is declared active, so a brand new panel fires the Referenced By retarget exactly once,
  // already carrying it (see ActiveRecordTracker's own doc comment on ordering).
  // onDidChangeViewState only needs to announce *gaining* focus: losing it to another record
  // panel is that other panel's own onDidChangeViewState(active) firing, which naturally
  // supersedes this one (ActiveRecordTracker.setActivePanel dedupes same-panel calls), and losing
  // it to a closed panel is removePanel's job.
  if (formKey) activeRecordTracker.setFormKey(panel, formKey);
  activeRecordTracker.setActivePanel(panel);
  panel.onDidChangeViewState(() => {
    if (panel.active) activeRecordTracker.setActivePanel(panel);
  });
  panel.onDidDispose(() => activeRecordTracker.removePanel(panel));

  panel.webview.onDidReceiveMessage((msg: unknown) => {
    // Every reply below must reach the one panel that
    // asked, never a broadcast (see messages.ts' FORM_KEY_PICKED/CONDITION_FUNCTION_PICKED/
    // OPEN_EXTENDED_EDITOR doc comments) — routerDeps itself is shared across every panel (built
    // once in registerRecordViewCommands), so these are the per-panel fields, rebuilt fresh on
    // every message with the panel this closure already holds.
    const reply = (m: ExtensionToWebview) => { void panel.webview.postMessage(m); };
    void routeRecordPanelMessage(msg, {
      ...routerDeps,
      formKeyPicker: { repository: routerDeps.repository, reply },
      conditionFunctionPicker: { repository: routerDeps.repository, reply },
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
// A right-clicked Plugins-tree record/placed-reference row, a multi-selection of them, or
// the Referenced By group row's own plain shape — whichever one duck-types against, resolved to
// the (formKey, label) pair openRecordPanel needs. `'kind' in node` (not `instanceof`), matching
// recordCopyIdentity's existing convention above — keeps this testable against plain object
// literals shaped like the real tree nodes, with no dependency on constructing one.
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
// Opens one non-retargeting panel per identity, all landing as tabs in a single new editor
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

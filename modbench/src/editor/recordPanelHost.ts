import * as vscode from 'vscode';
import * as path from 'node:path';
import * as os from 'node:os';
import type { MEditClient } from '../client';
import { ReferencedByGroupNode, referencedByCopyText, type ReferencedByTreeNode } from './ReferencedByTreeProvider';
import { ActiveRecordTracker } from './ActiveRecordTracker';
import { buildWebviewHtml } from './webviewHtml';
import { EXTENSION_TO_WEBVIEW, type ExtensionToWebview } from '../wire/messages';
import { routeRecordPanelMessage, type RouteRecordPanelMessageDeps } from './recordPanelMessageRouter';
import type { RecordWriteDeps } from './applyRecordEdit';
import { RecordDecorationProvider } from './RecordDecorationProvider';
import { makeOnRecordEdited, type RecordTreeSync } from './onRecordEdited';
import { registerRecordPanelContextCommands } from './recordPanelContextCommands';
import { registerRecordLifecycleCommands, registerRecordCopyCommands } from './recordLifecycleCommands';
import type { Reporter } from '../ports/reporter';
import type { AskQuestion } from '../ports/dialog';
import { errorMessage } from '../ports/errorMessage';

export interface EditorCommandDeps {
  context: vscode.ExtensionContext;
  openPanels: Map<string, vscode.WebviewPanel>;
  // Every open 'modbench'-viewType record panel — see openRecordPanel's recordPanels param.
  recordPanels: Set<vscode.WebviewPanel>;
  // Which of recordPanels is active, and what FormKey each shows — openRecordPanel keeps
  // this current; the Referenced By view retargets from it, not from a command argument.
  activeRecordTracker: ActiveRecordTracker<vscode.WebviewPanel>;
  port: number;
  // Editor's own view of the Plugins tree, structural rather than the tree's own type — see
  // `RecordTreeSync`'s own doc comment.
  treeSync: RecordTreeSync;
  meditClient: Pick<MEditClient,
    | 'editRecord' | 'searchRecords'
    | 'createRecord' | 'deleteRecord' | 'renumberRecord' | 'copyRecordAsOverride' | 'copyRecordAsNewRecord'
    | 'getPlugins' | 'getRecordOverridePlugins' | 'peekNextFreeFormKey' | 'getReferences'>;
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
  // The two ports (ADR-0019), built over the window API by the composition root: this box
  // surfaces a failure and asks a question, and implements neither.
  reporterFor: (tag: string) => Reporter;
  ask: AskQuestion;
}
// ADR-0007: the single write path. A panel showing this record re-reads on rows-changed from the
// notification stream (ADR-0015 invariant 3), not a broadcast from here.
function recordPanelWriteDeps(
  deps: EditorCommandDeps, recordDecorationProvider: RecordDecorationProvider,
): RecordWriteDeps {
  return {
    meditClient: deps.meditClient,
    onRecordEdited: makeOnRecordEdited(
      deps.treeSync, recordDecorationProvider,
      () => { deps.refreshMatchingPlugins(); },
      (plugin) => deps.refreshSourceControlFor(plugin),
    ),
    // ADR-0019 surfacing for a refused edit, and for a failed clipboard write.
    reporter: deps.reporterFor('recordPanel'),
  };
}

export function registerEditorCommands(deps: EditorCommandDeps): vscode.Disposable[] {
  const {
    context, openPanels, recordPanels, activeRecordTracker, port, treeSync, meditClient,
    referencedByTreeView, outputChannel, mergedTreeSelection, refreshMatchingPlugins,
  } = deps;
  // One decoration provider per activation: its lookup reads treeSync's cache live, so it
  // needs no copy of that state.
  const recordDecorationProvider = new RecordDecorationProvider(
    (plugin, origin, formKey) => treeSync.workingTreeStateOf(plugin, origin, formKey));
  const writeDeps = recordPanelWriteDeps(deps, recordDecorationProvider);
  // `formKeyPicker` is a placeholder here and rebuilt per panel below, since its reply must reach
  // the one panel that asked.
  const routerDeps: RouteRecordPanelMessageDeps = {
    ...writeDeps, meditClient, channel: outputChannel, formKeyPicker: undefined,
  };
  return [
    vscode.window.registerFileDecorationProvider(recordDecorationProvider),
    // The native right-click menus write from here directly, with no panel in the path — the same
    // write deps the router has, plus the extended editor's temp root and log.
    ...registerRecordPanelContextCommands({
      ...writeDeps, tempRoot: extendedFieldEditorTempRoot, log: (m: string) => outputChannel.debug(m),
    }),
    // Editor owns the record gestures (create/delete/renumber/copy) — registered once, here,
    // rather than from the Plugins-row command registration.
    ...registerRecordLifecycleCommands(
      meditClient, outputChannel, deps.reporterFor('recordLifecycle'), deps.ask, treeSync, refreshMatchingPlugins),
    ...registerRecordCopyCommands(
      meditClient, outputChannel, deps.reporterFor('recordCopy'), deps.ask, treeSync, refreshMatchingPlugins),
    vscode.commands.registerCommand('modbench.openEditor', (args?: { formKey?: string; label?: string }) => {
      openRecordPanel(context, openPanels, args?.label ?? args?.formKey ?? 'mEdit', args?.formKey, port,
        vscode.ViewColumn.One, { routerDeps, recordPanels, activeRecordTracker, singleton: true });
    }),
    // A named "Open to the Side" (ADR-0018), not a right-click side effect. `item`/`allSelected`
    // mirror VS Code's view/item/context invocation shape, falling back to the tree's current
    // selection when neither is supplied.
    vscode.commands.registerCommand('modbench.openEditorBeside',
      (item?: unknown, allSelected?: unknown[]) => {
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
    // Retargets nothing — the view follows activeRecordTracker on its own.
    // Kept as a Command Palette reveal-this-view convenience; no menu invokes this.
    vscode.commands.registerCommand('modbench.showReferencedBy',
      () => vscode.commands.executeCommand('modbench.referencedByTree.focus')),
    // xEdit parity (xeMainForm.pas's CopyInto). One command behind both a keybinding and a menu
    // entry: ADR-0018's "no action reachable two ways" bars redundant affordances, not this.
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
          deps.reporterFor('referencedByTree.copy').report(
            'error', 'Could not copy to the clipboard.', errorMessage(err));
        }
      }),
  ];
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
    // A reply must reach the one panel that asked, never a broadcast; `routerDeps` is shared
    // across panels, so this per-panel field is rebuilt with the panel this closure holds.
    const reply = (m: ExtensionToWebview) => { void panel.webview.postMessage(m); };
    void routeRecordPanelMessage(msg, {
      ...routerDeps,
      formKeyPicker: { meditClient: routerDeps.meditClient, reply },
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

import * as vscode from 'vscode';
import type { MEditClient } from '../client';
import { ActiveRecordTracker } from './ActiveRecordTracker';
import type { EditsInFlight } from './followRecord';
import { buildWebviewHtml } from './webviewHtml';
import { routeRecordPanelMessage, routerDepsForPanel, type SharedRecordPanelDeps } from './recordPanelMessageRouter';
import type { FocusedCells } from './focusedCells';
import type { RecordWriteDeps } from './applyRecordEdit';
import type { ExtendedFieldEditorDeps } from './extendedFieldEditor';
import { RecordDecorationProvider, type RecordBadgeSource } from './RecordDecorationProvider';
import { registerRecordPanelContextCommands } from './recordPanelContextCommands';
import { registerRecordLifecycleCommands, registerRecordCopyCommands } from './recordLifecycleCommands';
import { trackConflictsComputed } from './conflictsComputedTracker';
import type { Reporter } from '../ports/reporter';
import type { AskQuestion } from '../ports/dialog';
import { recordUri, formKeyOfRecordUri, RECORD_EDITOR_VIEW_TYPE, type RecordAddress } from './recordUri';
import { recordOpenPlan, type RecordOpenPlan } from './recordOpenPlan';
import { recordTitle } from './recordTitle';

export interface EditorCommandDeps {
  context: Pick<vscode.ExtensionContext, 'extensionUri'>;
  // Every open 'modbench.record' custom editor's panel — see RecordEditorProvider's
  // resolveCustomEditor.
  recordPanels: Set<vscode.WebviewPanel>;
  // Which of recordPanels is active, and what FormKey each shows — the Referenced By view
  // retargets from it, not from a command argument.
  activeRecordTracker: ActiveRecordTracker<vscode.WebviewPanel>;
  // Each panel's edits in flight, which hold its reads until the answer; the same instance gates
  // the notification wiring.
  editsInFlight: EditsInFlight<vscode.WebviewPanel>;
  // Each panel's focused cell, which a field gesture from the palette acts on.
  focusedCells: FocusedCells<vscode.WebviewPanel>;
  recordBadgeSource: RecordBadgeSource;
  meditClient: Pick<MEditClient,
    | 'editRecord' | 'searchRecords'
    | 'deleteRecords' | 'copyRecords'
    | 'getPlugins' | 'getRecordHolders'
    | 'getComparison' | 'subscribe' | 'onStatusChanged' | 'onReconnected'>;
  // The merged Plugins tree's selection, which the record gestures act on. Narrowed to the one
  // cross-context fact this file needs, not the composition root's session object.
  mergedTreeSelection: () => readonly unknown[];
  // The plugin's Source Control status, which a committed field edit redrives, lives on the session
  // object, narrowed to a callback like mergedTreeSelection.
  refreshSourceControlFor: (plugin: string, origin: string) => void;
  outputChannel: Pick<vscode.LogOutputChannel, 'debug' | 'info' | 'warn'>;
  // The two ports (ADR-0019), built over the window API by the composition root: this box
  // surfaces a failure and asks a question, and implements neither.
  reporterFor: (tag: string) => Reporter;
  ask: AskQuestion;
  // Where an extended-editor tab is written, answered at the composition root.
  fieldFile: ExtendedFieldEditorDeps['fieldFile'];
}
// ADR-0007: the single write path. A panel showing this record re-reads on rows-changed from the
// notification stream (ADR-0015 invariant 3), not a broadcast from here.
function recordPanelWriteDeps(deps: EditorCommandDeps): RecordWriteDeps {
  return {
    meditClient: deps.meditClient,
    refreshSourceControlFor: (plugin, origin) => { deps.refreshSourceControlFor(plugin, origin); },
    // ADR-0019 surfacing for a refused edit, and for a failed clipboard write.
    reporter: deps.reporterFor('recordPanel'),
  };
}

// The document model RecordEditorProvider hands back to VS Code: an opaque handle naming only the
// FormKey its URI addresses.
class RecordDocument implements vscode.CustomDocument {
  constructor(readonly uri: vscode.Uri, readonly formKey: string) {}
  dispose(): void { /* no owned resources */ }
}

interface RecordEditorProviderDeps {
  context: Pick<vscode.ExtensionContext, 'extensionUri'>;
  recordPanels: Set<vscode.WebviewPanel>;
  activeRecordTracker: ActiveRecordTracker<vscode.WebviewPanel>;
  editsInFlight: EditsInFlight<vscode.WebviewPanel>;
  focusedCells: FocusedCells<vscode.WebviewPanel>;
  panelsById: Map<string, vscode.WebviewPanel>;
  routerDeps: SharedRecordPanelDeps;
}

let panelsOpened = 0;

// A VS Code custom editor, one per record address: preview, pinning, history, closed-tab
// reopening and restore-after-reload are VS Code's own, for any tab backed by a URI.
class RecordEditorProvider implements vscode.CustomReadonlyEditorProvider<RecordDocument> {
  constructor(private readonly deps: RecordEditorProviderDeps) {}

  openCustomDocument(uri: vscode.Uri): RecordDocument {
    return new RecordDocument(uri, formKeyOfRecordUri(uri));
  }

  resolveCustomEditor(document: RecordDocument, panel: vscode.WebviewPanel): void {
    const {
      context, recordPanels, activeRecordTracker, editsInFlight, focusedCells, panelsById, routerDeps,
    } = this.deps;
    const formKey = document.formKey;
    panel.title = recordTitle(formKey, undefined);

    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'out', 'webview')],
    };

    recordPanels.add(panel);
    panel.onDidDispose(() => recordPanels.delete(panel));
    const panelId = `record-panel-${++panelsOpened}`;
    panelsById.set(panelId, panel);
    panel.onDidDispose(() => { panelsById.delete(panelId); editsInFlight.forget(panel); });

    // FormKey is recorded before the panel is declared active, so a new panel fires the
    // Referenced By retarget exactly once, already carrying it. onDidChangeViewState announces
    // only *gaining* focus: losing it is another panel's event, or removePanel's job.
    activeRecordTracker.setFormKey(panel, formKey);
    activeRecordTracker.setActivePanel(panel);
    focusedCells.setActivePanel(panel);
    panel.onDidChangeViewState(() => {
      if (!panel.active) return;
      activeRecordTracker.setActivePanel(panel);
      focusedCells.setActivePanel(panel);
    });
    panel.onDidDispose(() => {
      activeRecordTracker.removePanel(panel);
      focusedCells.removePanel(panel);
    });

    panel.webview.onDidReceiveMessage((msg: unknown) => {
      // A reply and a follow reach the one panel that asked, never a broadcast; `routerDeps` is
      // shared across panels, so the per-panel fields are rebuilt with the panel this closure holds.
      void routeRecordPanelMessage(msg, routerDepsForPanel(routerDeps, panel, panelId, focusedCells));
    });

    const scriptUri = panel.webview.asWebviewUri(
      vscode.Uri.joinPath(context.extensionUri, 'out', 'webview', 'assets', 'main.js'),
    );
    panel.webview.html = buildWebviewHtml({ panelId, formKey, scriptUri: scriptUri.toString(), cspSource: panel.webview.cspSource });
  }
}

export function registerEditorCommands(deps: EditorCommandDeps): vscode.Disposable[] {
  const {
    context, recordPanels, activeRecordTracker, editsInFlight, focusedCells, recordBadgeSource, meditClient,
    outputChannel, mergedTreeSelection,
  } = deps;
  // One decoration provider per activation: it reads the tree's cache live, so it needs no copy
  // of that state.
  const recordDecorationProvider = new RecordDecorationProvider(recordBadgeSource);
  const panelsById = new Map<string, vscode.WebviewPanel>();
  const writeDeps = recordPanelWriteDeps(deps);
  // Lives for the activation, like the decoration provider above — disposed alongside it.
  const conflictsComputedTracker = trackConflictsComputed(meditClient);
  // The picker and the panel's name are each panel's own, added per panel below.
  const routerDeps: SharedRecordPanelDeps = {
    ...writeDeps, meditClient, channel: outputChannel, conflictsComputed: () => conflictsComputedTracker.current(),
  };
  const recordEditorProvider = new RecordEditorProvider({
    context, recordPanels, activeRecordTracker, editsInFlight, focusedCells, panelsById, routerDeps,
  });

  return [
    recordDecorationProvider,
    { dispose: () => { conflictsComputedTracker.dispose(); } },
    vscode.window.registerFileDecorationProvider(recordDecorationProvider),
    vscode.window.registerCustomEditorProvider(
      RECORD_EDITOR_VIEW_TYPE, recordEditorProvider, { webviewOptions: { retainContextWhenHidden: true } }),
    // The native right-click menus write from here directly, with no panel in the path — the same
    // write deps the router has, plus the extended editor's temp root and log.
    ...registerRecordPanelContextCommands({
      ...writeDeps, fieldFile: deps.fieldFile, log: (m: string) => outputChannel.debug(m),
      editGateOf: (panelId) => {
        const panel = panelId === undefined ? undefined : panelsById.get(panelId);
        return panel
          ? editsInFlight.gate(panel)
          // The panel the menu came from has closed, so no panel's reads wait on this write.
          : async (address, write) => { await write(address.formKey); };
      },
      focusedCell: () => focusedCells.current(),
    }),
    // Editor owns the record gestures (delete/copy) — registered once, here,
    // rather than from the Plugins-row command registration.
    ...registerRecordLifecycleCommands(
      meditClient, deps.reporterFor('recordLifecycle'), deps.ask, mergedTreeSelection),
    ...registerRecordCopyCommands(
      meditClient, deps.reporterFor('recordCopy'), deps.ask, mergedTreeSelection),
    vscode.commands.registerCommand('modbench.record.open', (argument?: unknown, selection?: unknown) =>
      openRecordTabs(recordOpenPlan(argument, selection))),
    // Retargets nothing — the view follows activeRecordTracker on its own.
    // Kept as a Command Palette reveal-this-view convenience; no menu invokes this.
    vscode.commands.registerCommand('modbench.record.showReferencedBy',
      () => vscode.commands.executeCommand('modbench.referencedByTree.focus')),
  ];
}

async function openRecordTab(address: RecordAddress, viewColumn: vscode.ViewColumn, preview: boolean): Promise<void> {
  await vscode.commands.executeCommand('vscode.openWith', recordUri(address), RECORD_EDITOR_VIEW_TYPE, { viewColumn, preview });
}

// `ViewColumn.Beside` resolves once: the first tab opened becomes active, so a second Beside call
// would cascade a new column per record — the await lets this loop read it after each tab settles.
async function openRecordTabs({ addresses, beside, preview }: RecordOpenPlan): Promise<void> {
  let column: vscode.ViewColumn = beside ? vscode.ViewColumn.Beside : vscode.ViewColumn.One;
  for (const address of addresses) {
    await openRecordTab(address, column, preview);
    if (beside) column = vscode.window.tabGroups.activeTabGroup.viewColumn;
  }
}

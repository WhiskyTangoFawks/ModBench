import * as vscode from 'vscode';
import type { MEditClient } from '../client';
import { ActiveRecordTracker } from './ActiveRecordTracker';
import type { EditsInFlight } from './followRecord';
import { buildWebviewHtml } from './webviewHtml';
import { pickRecord } from './recordPicker';
import { routeRecordPanelMessage, routerDepsForPanel, type SharedRecordPanelDeps } from './recordPanelMessageRouter';
import type { FocusedCells } from './focusedCells';
import type { RecordWriteDeps } from './applyRecordEdit';
import type { ExtendedFieldEditorDeps } from './extendedFieldEditor';
import { RecordDecorationProvider, type RecordBadgeSource } from './RecordDecorationProvider';
import { registerRecordPanelContextCommands } from './recordPanelContextCommands';
import {
  registerRecordLifecycleCommands, registerRecordCopyCommands, registerDeleteHereCommands, type RecordWriteMarks,
} from './recordLifecycleCommands';
import { trackLoadOrderStatus } from './loadOrderStatusTracker';
import type { Reporter } from '../ports/reporter';
import type { AskQuestion } from '../ports/dialog';
import { recordUri, formKeyOfRecordUri, RECORD_EDITOR_VIEW_TYPE, type RecordAddress } from './recordUri';
import { besideArgument, recordOpenPlan, type RecordOpenPlan } from './recordOpenPlan';
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
  // Every open panel re-reads the way a completed reconcile makes it (the plugins mEdit cannot
  // read changed).
  refreshPanels: () => void;
  // The rows selected in the view the user last selected in, which a palette entry acts on.
  focusedViewSelection: () => readonly unknown[];
  // Each view's own selection, which that view's keys act on.
  viewSelections: ReadonlyMap<string, () => readonly unknown[]>;
  // The rows a record delete or copy changes, which a view marks until the disk confirms the write.
  recordMarks: RecordWriteMarks;
  // The plugin's Source Control status, which a committed field edit redrives, lives on the session
  // object, narrowed to a callback like focusedViewSelection.
  refreshSourceControlFor: (plugin: string, origin: string) => void;
  outputChannel: Pick<vscode.LogOutputChannel, 'debug' | 'info' | 'warn'>;
  // The two ports (ADR-0019), built over the window API by the composition root: this box
  // surfaces a failure and asks a question, and implements neither.
  reporterFor: (tag: string) => Reporter;
  ask: AskQuestion;
  // Where an extended-editor tab is written, answered at the composition root.
  fieldFile: ExtendedFieldEditorDeps['fieldFile'];
}
// ADR-0007: the single write path. A panel showing this record re-reads only on rows-changed from
// the notification stream (ADR-0015 invariant 3).
function recordPanelWriteDeps(deps: EditorCommandDeps): RecordWriteDeps {
  return {
    meditClient: deps.meditClient,
    refreshSourceControlFor: (plugin, origin) => { deps.refreshSourceControlFor(plugin, origin); },
    // ADR-0019 surfacing for a refused edit.
    reporter: deps.reporterFor('recordPanel'),
    tellPanels: (message) => { for (const panel of deps.recordPanels) void panel.webview.postMessage(message); },
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
  routerDeps: SharedRecordPanelDeps;
}

// A VS Code custom editor, one per record address: preview, pinning, history, closed-tab
// reopening and restore-after-reload are VS Code's own, for any tab backed by a URI.
class RecordEditorProvider implements vscode.CustomReadonlyEditorProvider<RecordDocument> {
  constructor(private readonly deps: RecordEditorProviderDeps) {}

  openCustomDocument(uri: vscode.Uri): RecordDocument {
    return new RecordDocument(uri, formKeyOfRecordUri(uri));
  }

  resolveCustomEditor(document: RecordDocument, panel: vscode.WebviewPanel): void {
    const {
      context, recordPanels, activeRecordTracker, editsInFlight, focusedCells, routerDeps,
    } = this.deps;
    const formKey = document.formKey;
    panel.title = recordTitle(formKey, undefined);

    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'out', 'webview')],
    };

    recordPanels.add(panel);
    panel.onDidDispose(() => recordPanels.delete(panel));
    panel.onDidDispose(() => { editsInFlight.forget(panel); });

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
      void routeRecordPanelMessage(msg, routerDepsForPanel(routerDeps, panel, focusedCells));
    });

    const asset = (file: string) => panel.webview.asWebviewUri(
      vscode.Uri.joinPath(context.extensionUri, 'out', 'webview', 'assets', file),
    ).toString();
    panel.webview.html = buildWebviewHtml({
      formKey, scriptUri: asset('main.js'), styleUri: asset('main.css'), cspSource: panel.webview.cspSource,
    });
  }
}

export function registerEditorCommands(deps: EditorCommandDeps): vscode.Disposable[] {
  const {
    context, recordPanels, activeRecordTracker, editsInFlight, focusedCells, recordBadgeSource, meditClient,
    outputChannel,
  } = deps;
  // One decoration provider per activation: it reads the tree's cache live, so it needs no copy
  // of that state.
  const recordDecorationProvider = new RecordDecorationProvider(recordBadgeSource);
  const writeDeps = recordPanelWriteDeps(deps);
  // Lives for the activation, like the decoration provider above — disposed alongside it.
  const loadOrderStatusTracker = trackLoadOrderStatus(
    meditClient, deps.refreshPanels);
  // The picker and the panel's name are each panel's own, added per panel below.
  const routerDeps: SharedRecordPanelDeps = {
    ...writeDeps, meditClient, channel: outputChannel, conflictsComputed: () => loadOrderStatusTracker.current(),
    loadFailures: () => loadOrderStatusTracker.failures(),
  };
  const recordEditorProvider = new RecordEditorProvider({
    context, recordPanels, activeRecordTracker, editsInFlight, focusedCells, routerDeps,
  });

  return [
    recordDecorationProvider,
    { dispose: () => { loadOrderStatusTracker.dispose(); } },
    vscode.window.registerFileDecorationProvider(recordDecorationProvider),
    vscode.window.registerCustomEditorProvider(
      RECORD_EDITOR_VIEW_TYPE, recordEditorProvider, { webviewOptions: { retainContextWhenHidden: true } }),
    // The native right-click menus write from here directly, with no panel in the path — the same
    // write deps the router has, plus the extended editor's temp root and log.
    ...registerRecordPanelContextCommands({
      ...writeDeps, fieldFile: deps.fieldFile, log: (m: string) => outputChannel.debug(m),
      editGateOf: address => editsInFlight.gateShowing(recordPanels, address),
      focusedCell: () => focusedCells.current(),
    }),
    // Editor owns the record gestures (delete/copy) — registered once, here,
    // rather than from the Plugins-row command registration.
    ...registerRecordLifecycleCommands(
      meditClient, deps.reporterFor('recordLifecycle'), deps.ask, deps.focusedViewSelection, deps.recordMarks),
    ...registerRecordCopyCommands(
      meditClient, deps.reporterFor('recordCopy'), deps.ask, deps.focusedViewSelection, deps.recordMarks),
    ...registerDeleteHereCommands(deps.viewSelections),
    vscode.commands.registerCommand('modbench.record.open', async (argument?: unknown) => {
      const plan = recordOpenPlan(argument, deps.focusedViewSelection());
      if (plan.addresses.length > 0) return openRecordTabs(plan);
      const reporter = deps.reporterFor('recordOpen');
      if (argument !== undefined) {
        reporter.report('error', 'Could not open a record.', 'What was given names no record.');
        return;
      }
      const formKey = await pickRecord({ meditClient, reporter }, '', []);
      if (formKey) await openRecordTab({ formKey }, vscode.ViewColumn.One, true);
    }),
    vscode.commands.registerCommand('modbench.record.openToSide', (row?: unknown, selection?: unknown) =>
      vscode.commands.executeCommand('modbench.record.open', besideArgument(row, selection))),
  ];
}

async function openRecordTab(address: RecordAddress, viewColumn: vscode.ViewColumn, preview: boolean): Promise<void> {
  await vscode.commands.executeCommand('vscode.openWith', recordUri(address), RECORD_EDITOR_VIEW_TYPE, { viewColumn, preview });
}

// `ViewColumn.Beside` resolves once: the first tab opened becomes active, so a second Beside call
// would cascade a new column per record — the await lets this loop read it after each tab settles.
async function openRecordTabs({ addresses, column: placement, preview }: RecordOpenPlan): Promise<void> {
  let column: vscode.ViewColumn = { one: vscode.ViewColumn.One, beside: vscode.ViewColumn.Beside, active: vscode.ViewColumn.Active }[placement];
  for (const address of addresses) {
    await openRecordTab(address, column, preview);
    if (placement === 'beside') column = vscode.window.tabGroups.activeTabGroup.viewColumn;
  }
}

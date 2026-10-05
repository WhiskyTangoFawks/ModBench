import * as vscode from 'vscode';
import type { MEditClient } from '../client';
import { ActiveRecordTracker } from './ActiveRecordTracker';
import type { EditAddress, EditsInFlight } from './followRecord';
import { showWebviewPage } from '../drivingLib/webviewPage';
import { reportFailure } from '../drivingLib/reportFailure';
import { pickRecord } from './recordPicker';
import { routeRecordPanelMessage, routerDepsForPanel, type SharedRecordPanelDeps } from './recordPanelMessageRouter';
import type { FocusedCells } from './focusedCells';
import type { RecordWriteDeps } from './applyRecordEdit';
import { ExtendedFieldDocuments } from './extendedFieldEditor';
import { commitField, registerRecordPanelContextCommands } from './recordPanelContextCommands';
import { registerGridKeyCommands } from './gridKeyCommands';
import {
  registerRecordLifecycleCommands, registerRecordCopyCommands, registerDeleteHereCommands,
} from './recordLifecycleCommands';
import { announceConflictsComputed, subscribeRecordPanelsToNotifications } from './notificationWiring';
import { trackLoadOrderStatus } from './loadOrderStatusTracker';
import type { RecordWrite } from '../drivingLib/writingGesture';
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
  meditClient: Pick<MEditClient,
    | 'editRecord' | 'searchRecords'
    | 'deleteRecords' | 'copyRecords'
    | 'getPlugins' | 'getRecordHolders'
    | 'getComparison' | 'onNotification' | 'onStatusChanged' | 'onReconnected' | 'getRecordOwner'>;
  // The rows selected in the view the user last selected in, which a palette entry acts on.
  focusedViewSelection: () => readonly unknown[];
  // Each view's own selection, which that view's keys act on.
  viewSelections: ReadonlyMap<string, () => readonly unknown[]>;
  recordWrite: RecordWrite;
  // The plugin's Source Control status, which a committed field edit redrives, lives on the session
  // object, narrowed to a callback like focusedViewSelection.
  refreshSourceControlFor: (plugin: string, origin: string) => void;
  outputChannel: Pick<vscode.LogOutputChannel, 'debug' | 'info' | 'warn'>;
  // Kernel ports the composition root implements (target-architecture.d2, Ports).
  reporterFor: (tag: string) => Reporter;
  ask: AskQuestion;
}
// ADR-0015; editor.md, States, story 5.
function recordPanelWriteDeps(deps: EditorCommandDeps): RecordWriteDeps {
  return {
    meditClient: deps.meditClient,
    refreshSourceControlFor: (plugin, origin) => { deps.refreshSourceControlFor(plugin, origin); },
    // Surfaces a refused edit (ADR-0019).
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

    recordPanels.add(panel);
    panel.onDidDispose(() => recordPanels.delete(panel));
    panel.onDidDispose(() => { editsInFlight.forget(panel); });

    // FormKey is recorded before the panel is declared active, so a new panel fires the
    // Referenced By retarget exactly once, already carrying it. onDidChangeViewState announces
    // only *gaining* focus: losing it is another panel's event, or removePanel's job.
    activeRecordTracker.setFormKey(panel, formKey);
    activeRecordTracker.setActivePanel(panel);
    focusedCells.panelFocused();
    panel.onDidChangeViewState(() => {
      if (!panel.active) return;
      activeRecordTracker.setActivePanel(panel);
      focusedCells.panelFocused();
    });
    panel.onDidDispose(() => {
      focusedCells.removePanel(panel);
      activeRecordTracker.removePanel(panel);
    });

    panel.webview.onDidReceiveMessage((msg: unknown) => {
      // A reply and a follow reach the one panel that asked, never a broadcast; `routerDeps` is
      // shared across panels, so the per-panel fields are rebuilt with the panel this closure holds.
      void routeRecordPanelMessage(msg, routerDepsForPanel(routerDeps, panel, focusedCells));
    });

    showWebviewPage(panel.webview, context.extensionUri, {
      script: 'main.js', globals: { mEditFormKey: formKey },
    });
  }
}

export function registerEditorCommands(deps: EditorCommandDeps): vscode.Disposable[] {
  const {
    context, recordPanels, activeRecordTracker, editsInFlight, focusedCells, meditClient,
    outputChannel,
  } = deps;
  const writeDeps = recordPanelWriteDeps(deps);
  const commitDeps = { ...writeDeps, editGateOf: (address: EditAddress) => editsInFlight.gateShowing(recordPanels, address) };
  const extendedFields = new ExtendedFieldDocuments({
    client: meditClient, reporter: deps.reporterFor('extendedField'),
    commit: (field, value) => commitField(commitDeps, field, value),
  });
  // Lives for the activation, disposed with the editor commands.
  const loadOrderStatusTracker = trackLoadOrderStatus(
    meditClient, () => announceConflictsComputed(recordPanels, editsInFlight));
  // The picker and the panel's name are each panel's own, added per panel below.
  const routerDeps: SharedRecordPanelDeps = {
    ...writeDeps, meditClient, channel: outputChannel, conflictsComputed: () => loadOrderStatusTracker.current(),
    loadFailures: () => loadOrderStatusTracker.failures(),
  };
  const recordEditorProvider = new RecordEditorProvider({
    context, recordPanels, activeRecordTracker, editsInFlight, focusedCells, routerDeps,
  });

  return [
    { dispose: subscribeRecordPanelsToNotifications(meditClient, recordPanels, activeRecordTracker, editsInFlight) },
    extendedFields,
    { dispose: () => { loadOrderStatusTracker.dispose(); } },
    vscode.window.registerCustomEditorProvider(
      RECORD_EDITOR_VIEW_TYPE, recordEditorProvider, { webviewOptions: { retainContextWhenHidden: true } }),
    // The native right-click menus write from here directly, with no panel in the path — the same
    // write deps the router has, plus the extended-field documents.
    ...registerRecordPanelContextCommands({
      ...commitDeps, extendedFields,
      focusedCell: () => focusedCells.current(),
    }),
    ...registerGridKeyCommands({
      focusedCell: () => focusedCells.current(),
      tellFocusedPanel: (message) => { void activeRecordTracker.activePanel()?.webview.postMessage(message); },
    }),
    // Editor owns the record gestures (delete/copy) — registered once, here,
    // rather than from the Plugins-row command registration.
    ...registerRecordLifecycleCommands(
      meditClient, deps.reporterFor('recordLifecycle'), deps.ask, deps.focusedViewSelection, deps.recordWrite),
    ...registerRecordCopyCommands(
      meditClient, deps.reporterFor('recordCopy'), deps.ask, deps.focusedViewSelection, deps.recordWrite),
    ...registerDeleteHereCommands(deps.viewSelections),
    vscode.commands.registerCommand('modbench.record.open', async (argument?: unknown) => {
      const plan = recordOpenPlan(argument, deps.focusedViewSelection());
      const reporter = deps.reporterFor('recordOpen');
      if (plan.addresses.length > 0) return openRecordTabs(reporter, plan);
      if (argument !== undefined) {
        reporter.report('error', 'Could not open a record.', 'What was given names no record.');
        return;
      }
      const formKey = await pickRecord({ meditClient, reporter }, '', []);
      if (formKey) await openRecordTab(reporter, { formKey }, vscode.ViewColumn.Active, true);
    }),
    vscode.commands.registerCommand('modbench.record.openToSide', (row?: unknown, selection?: unknown) =>
      vscode.commands.executeCommand('modbench.record.open', besideArgument(row, selection))),
  ];
}

async function openRecordTab(
  reporter: Reporter, address: RecordAddress, viewColumn: vscode.ViewColumn, preview: boolean,
): Promise<void> {
  await reportFailure(reporter, `Failed to open "${address.formKey}".`, async () => {
    await vscode.commands.executeCommand('vscode.openWith', recordUri(address), RECORD_EDITOR_VIEW_TYPE, { viewColumn, preview });
  });
}

// `ViewColumn.Beside` resolves once: the first tab opened becomes active, so a second Beside call
// would cascade a new column per record — the await lets this loop read it after each tab settles.
async function openRecordTabs(reporter: Reporter, { addresses, beside, preview }: RecordOpenPlan): Promise<void> {
  let column: vscode.ViewColumn = beside ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active;
  for (const address of addresses) {
    await openRecordTab(reporter, address, column, preview);
    if (beside) column = vscode.window.tabGroups.activeTabGroup.viewColumn;
  }
}

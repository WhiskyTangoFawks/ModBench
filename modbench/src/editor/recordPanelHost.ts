import * as vscode from 'vscode';
import type { MEditClient } from '../client';
import type { PluginAddress } from '../wire/pluginAddress';
import { ActiveRecordTracker } from './ActiveRecordTracker';
import type { EditAddress, EditsInFlight } from './followRecord';
import { showWebviewPage } from '../drivingLib/webviewPage';
import { reportFailure } from '../drivingLib/reportFailure';
import { pickRecord } from './recordPicker';
import {
  routeRecordPanelMessage, routerDepsForPanel, type SharedRecordPanelDeps, type TitleFromRead,
} from './recordPanelMessageRouter';
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
import { besideArgument, recordOpenPlan, type RecordOpenPlan, type RecordToOpen } from './recordOpenPlan';
import { recordTitle } from './recordTitle';
import { RENDERED_DOCUMENT_SCHEME, RenderedDocuments, renderedDocumentUri } from './renderedDocument';
import { CHILD_RECORD_SCHEME, ChildRecordDocuments, childRecordUri } from './childRecordDocument';
import { copyOf, holdsNoCopy } from './recordCopy';
import { errorMessage } from '../ports/errorMessage';

export interface EditorCommandDeps {
  context: Pick<vscode.ExtensionContext, 'extensionUri'>;
  // Every open record tab's panel showing a record.
  recordPanels: Set<vscode.WebviewPanel>;
  // Which of recordPanels is active, and what FormKey each shows — the Referenced By view
  // retargets from it, not from a command argument.
  activeRecordTracker: ActiveRecordTracker<vscode.WebviewPanel>;
  // Each panel's edits in flight, which hold its reads until the answer; the one place a panel
  // reads again.
  editsInFlight: EditsInFlight<vscode.WebviewPanel>;
  // Each panel's focused cell, which a field gesture from the palette acts on.
  focusedCells: FocusedCells<vscode.WebviewPanel>;
  meditClient: Pick<MEditClient,
    | 'editRecord' | 'searchRecords'
    | 'deleteRecords' | 'copyRecords'
    | 'getPlugins' | 'getRecordHolders' | 'getRecordsWithChildren' | 'getChildrenInDestinations'
    | 'getComparison' | 'onNotification' | 'onStatusChanged' | 'onReconnected' | 'getRecordOwner'
    | 'getRecordFile' | 'getRecordOfFile' | 'getRenderedDocument'>;
  // The rows selected in the view the user last selected in, which a palette entry acts on.
  focusedViewSelection: () => readonly unknown[];
  // Each view's own selection, which that view's keys act on.
  viewSelections: ReadonlyMap<string, () => readonly unknown[]>;
  recordWrite: RecordWrite;
  // The plugin's Source Control status, which a committed field edit redrives, lives on the session
  // object, narrowed to a callback like focusedViewSelection.
  refreshSourceControlFor: (plugin: PluginAddress) => void;
  outputChannel: Pick<vscode.LogOutputChannel, 'debug' | 'info' | 'warn'>;
  // Kernel ports the composition root implements (target-architecture.d2, Ports).
  reporterFor: (tag: string) => Reporter;
  ask: AskQuestion;
}
// ADR-0015; editor.md, States, story 5.
function recordPanelWriteDeps(deps: EditorCommandDeps): RecordWriteDeps {
  return {
    meditClient: deps.meditClient,
    refreshSourceControlFor: (plugin) => { deps.refreshSourceControlFor(plugin); },
    // Surfaces a refused edit (ADR-0019).
    reporter: deps.reporterFor('recordPanel'),
  };
}

const RECORD_VIEW_TYPE = 'modbench.record';

interface ShowRecordDeps {
  context: Pick<vscode.ExtensionContext, 'extensionUri'>;
  recordPanels: Set<vscode.WebviewPanel>;
  activeRecordTracker: ActiveRecordTracker<vscode.WebviewPanel>;
  editsInFlight: EditsInFlight<vscode.WebviewPanel>;
  focusedCells: FocusedCells<vscode.WebviewPanel>;
  routerDeps: SharedRecordPanelDeps;
}

interface RecordEditorProviderDeps extends ShowRecordDeps {
  client: Pick<MEditClient, 'getRecordOfFile'>;
  channel: Pick<vscode.LogOutputChannel, 'warn'>;
}

// The grid as VS Code's editor for a record's file, a child's or a rendered document. A file's
// tab restored before mEdit holds the load order asks again on each load-order status.
class RecordEditorProvider implements vscode.CustomTextEditorProvider {
  private readonly unread = new Map<vscode.WebviewPanel, () => Promise<void>>();

  constructor(private readonly deps: RecordEditorProviderDeps) {}

  async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    if (document.uri.scheme === RENDERED_DOCUMENT_SCHEME) {
      showRecord(this.deps, panel, copyOf(document.uri).formKey, () => undefined);
      return;
    }
    if (document.uri.scheme === CHILD_RECORD_SCHEME) {
      // The file is the container's, so its name is not the child's.
      const { formKey, plugin } = copyOf(document.uri);
      panel.title = recordTitle(formKey, undefined);
      showRecord(this.deps, panel, formKey, (read, columns) => { panel.title = recordTitle(read, columns, plugin); });
      return;
    }
    const { fsPath } = document.uri;
    let shownReason: string | undefined;
    const read = async (): Promise<void> => {
      try {
        const { formKey } = await this.deps.client.getRecordOfFile(fsPath);
        if (this.unread.delete(panel)) showRecord(this.deps, panel, formKey, () => undefined);
      } catch (err) {
        const reason = errorMessage(err);
        if (reason === shownReason || !this.unread.has(panel)) return;
        shownReason = reason;
        this.deps.channel.warn(`Failed to read ${fsPath}: ${reason}`);
        showWebviewPage(panel.webview, this.deps.context.extensionUri, { script: 'main.js', globals: { mEditLoadError: reason } });
      }
    };
    this.unread.set(panel, read);
    panel.onDidDispose(() => this.unread.delete(panel));
    await read();
  }

  readAgain(): void {
    for (const read of this.unread.values()) void read();
  }
}

function showRecord(
  deps: ShowRecordDeps, panel: vscode.WebviewPanel, formKey: string, titleFromRead: TitleFromRead,
): void {
  const {
    context, recordPanels, activeRecordTracker, editsInFlight, focusedCells, routerDeps,
  } = deps;
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
    void routeRecordPanelMessage(msg, routerDepsForPanel(routerDeps, panel, focusedCells, editsInFlight, titleFromRead));
  });

  showWebviewPage(panel.webview, context.extensionUri, {
    script: 'main.js', globals: { mEditFormKey: formKey },
  });
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
  const providerDeps = { context, recordPanels, activeRecordTracker, editsInFlight, focusedCells, routerDeps };
  const recordEditorProvider = new RecordEditorProvider({ ...providerDeps, client: meditClient, channel: outputChannel });
  const keepsItsPlace = { webviewOptions: { retainContextWhenHidden: true } };

  return [
    { dispose: subscribeRecordPanelsToNotifications(meditClient, recordPanels, editsInFlight) },
    extendedFields,
    new RenderedDocuments(meditClient),
    new ChildRecordDocuments(meditClient),
    { dispose: () => { loadOrderStatusTracker.dispose(); } },
    vscode.window.registerCustomEditorProvider(RECORD_VIEW_TYPE, recordEditorProvider, keepsItsPlace),
    { dispose: meditClient.onNotification('load-order-status', () => { recordEditorProvider.readAgain(); }) },
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
      if (plan.addresses.length > 0) return openRecordTabs(meditClient, reporter, plan);
      if (argument !== undefined) {
        reporter.report('error', 'Could not open a record.', 'What was given names no record.');
        return;
      }
      const formKey = await pickRecord({ meditClient, reporter }, '', []);
      if (formKey) await openRecordTab(meditClient, reporter, { formKey }, vscode.ViewColumn.Active, true);
    }),
    vscode.commands.registerCommand('modbench.record.openToSide', (row?: unknown, selection?: unknown) =>
      vscode.commands.executeCommand('modbench.record.open', besideArgument(row, selection))),
  ];
}

type OpenClient = Pick<MEditClient, 'getRecordOwner' | 'getRecordFile' | 'getRecordOfFile' | 'getRenderedDocument'>;

async function openRecordTab(
  client: OpenClient, reporter: Reporter, address: RecordToOpen, viewColumn: vscode.ViewColumn, preview: boolean,
): Promise<void> {
  await reportFailure(reporter, `Failed to open "${recordTitle(address.formKey, undefined)}".`, async () => {
    const [uri, viewType] = await tabOf(client, address);
    await vscode.commands.executeCommand('vscode.openWith', uri, viewType, { viewColumn, preview });
  });
}

// A record given without a plugin opens its winning copy. A tracked copy opens as its own file and
// an untracked one as mEdit's rendering of it. A copy carried in another record's file opens as a
// child's document of that file.
async function tabOf(client: OpenClient, { formKey, plugin: given }: RecordToOpen): Promise<[vscode.Uri, string]> {
  const plugin = given ?? await client.getRecordOwner(formKey);
  if (!plugin) throw new Error(`No active plugin holds ${formKey}.`);
  const file = await client.getRecordFile(plugin, formKey);
  if (file === null) throw holdsNoCopy({ formKey, plugin });
  if (!file.path) {
    const rendered = await client.getRenderedDocument(plugin, formKey);
    if (rendered === null) throw holdsNoCopy({ formKey, plugin });
    return [renderedDocumentUri({ formKey, plugin }, rendered.fileName), RECORD_VIEW_TYPE];
  }
  if ((await client.getRecordOfFile(file.path)).formKey === formKey) return [vscode.Uri.file(file.path), RECORD_VIEW_TYPE];
  return [childRecordUri({ formKey, plugin }, file.path), RECORD_VIEW_TYPE];
}

// `ViewColumn.Beside` resolves once: the first tab opened becomes active, so a second Beside call
// would cascade a new column per record — the await lets this loop read it after each tab settles.
async function openRecordTabs(client: OpenClient, reporter: Reporter, { addresses, beside, preview }: RecordOpenPlan): Promise<void> {
  let column: vscode.ViewColumn = beside ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active;
  for (const address of addresses) {
    await openRecordTab(client, reporter, address, column, preview);
    if (beside) column = vscode.window.tabGroups.activeTabGroup.viewColumn;
  }
}

import * as vscode from 'vscode';
import type { MEditClient } from '../client';
import { pluginAddressOf, samePluginAddress, type PluginAddress } from '../wire/pluginAddress';
import { ActiveRecordTracker } from './ActiveRecordTracker';
import type { EditAddress, EditsInFlight } from './followRecord';
import { showWebviewPage } from '../drivingLib/webviewPage';
import { reportFailure } from '../drivingLib/reportFailure';
import { pickRecord } from './recordPicker';
import {
  routeRecordPanelMessage, routerDepsForPanel, type SharedRecordPanelDeps, type TabDocument,
} from './recordPanelMessageRouter';
import type { FocusedCells } from './focusedCells';
import { applyRecordEdit, oneAtATime, type RecordWriteDeps, type SourceMove } from './applyRecordEdit';
import { ExtendedFieldDocuments } from './extendedFieldEditor';
import { commitField, registerRecordPanelContextCommands, type FieldCommitDeps } from './recordPanelContextCommands';
import { registerGridKeyCommands } from './gridKeyCommands';
import {
  registerRecordLifecycleCommands, registerRecordCopyCommands, registerDeleteHereCommands,
} from './recordLifecycleCommands';
import { announceConflictsComputed, subscribeRecordPanelsToNotifications } from './notificationWiring';
import { trackLoadOrderStatus } from './loadOrderStatusTracker';
import type { RecordWrite } from '../drivingLib/writingGesture';
import type { Reporter } from '../ports/reporter';
import type { AskQuestion } from '../ports/dialog';
import { besideArgument, recordOpenPlan, type RecordOpenPlan, type RecordToOpen, type TabPlace } from './recordOpenPlan';
import { recordTitle } from './recordTitle';
import { inTabsPlace } from './inTabsPlace';
import { fileText } from './fileText';
import { RenderedDocuments } from './renderedDocument';
import { ChildRecordDocuments } from './childRecordDocument';
import {
  CHILD_RECORD_SCHEME, RENDERED_DOCUMENT_SCHEME, copyDocument, copyOf, recordDocument, type RecordCopy, type RecordDocument,
} from '../drivingLib/recordDocument';
import { errorMessage } from '../ports/errorMessage';
import { EXTENSION_TO_WEBVIEW, type ExtensionToWebview, type ViewState } from '../wire/messages';

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
    | 'getEditChanges' | 'searchRecords'
    | 'deleteRecords' | 'copyRecords'
    | 'getPlugins' | 'getRecordHolders' | 'getRecordsWithChildren' | 'getChildrenInDestinations'
    | 'getComparison' | 'getRecordsComparison' | 'onNotification' | 'onStatusChanged' | 'onReconnected' | 'getRecordOwner'
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
  client: Pick<MEditClient, 'getRecordOwner' | 'getRecordFile' | 'getRecordOfFile' | 'getRenderedDocument'>;
  channel: Pick<vscode.LogOutputChannel, 'warn'>;
}

// What a tab's page opens on: the record, the records beside it, and the place of the tab it stands in for.
interface GridPage { formKey: string; columns: readonly RecordCopy[]; place?: ViewState }

// The record a file's tab shows once an edit moves the file, the record it moved from, and the tab's place.
interface MovedTab extends RecordCopy { from?: string; columns: readonly RecordCopy[]; place: ViewState | undefined }

// Where `uri` stands once each move is made in order, each against the tree the one before it left.
const movedTo = (uri: vscode.Uri, moves: readonly SourceMove[]): vscode.Uri => moves.reduce((at, { from, to }) => {
  if (at.path === from.path) return to;
  return at.path.startsWith(`${from.path}/`) ? to.with({ path: to.path + at.path.slice(from.path.length) }) : at;
}, uri);

// The grid as VS Code's editor for a record's file, a child's or a rendered document. A file's
// tab restored before mEdit holds the load order asks again on each load-order status.
class RecordEditorProvider implements vscode.CustomTextEditorProvider {
  private readonly unread = new Map<vscode.WebviewPanel, () => Promise<void>>();
  // The columns an open asks for, until the tab it opens takes them.
  private readonly columnsToShow = new Map<string, readonly RecordCopy[]>();
  private readonly documentOf = new Map<vscode.WebviewPanel, string>();
  // The copy each tab's document holds, once it is shown.
  private readonly shown = new Map<vscode.WebviewPanel, { uri: vscode.Uri; plugin: PluginAddress }>();
  private readonly places = new Map<vscode.WebviewPanel, ViewState>();
  private readonly moved = new Map<string, MovedTab>();

  constructor(private readonly deps: RecordEditorProviderDeps) {}

  /** Opens the grid on `uri`, with `columns` beside the document's own copy, and none when there
   *  are none, so a tab shown again shows every active plugin's copy. */
  async open(uri: vscode.Uri, columns: readonly RecordCopy[], options: vscode.TextDocumentShowOptions): Promise<void> {
    const key = uri.toString();
    this.columnsToShow.set(key, columns);
    let untaken: readonly RecordCopy[] | undefined;
    try {
      await vscode.commands.executeCommand('vscode.openWith', uri, RECORD_VIEW_TYPE, options);
    } finally {
      untaken = this.columnsToShow.get(key);
      this.columnsToShow.delete(key);
    }
    if (!untaken) return;
    // No new tab took them, so VS Code showed the document's tab already open in the group, which
    // is active now (editor.md, Opening, story 3).
    for (const [panel, document] of this.documentOf) {
      if (document === key && panel.active) {
        void panel.webview.postMessage({ type: EXTENSION_TO_WEBVIEW.SHOW_COLUMNS, columns: [...untaken] } satisfies ExtensionToWebview);
      }
    }
  }

  /** The document carrying the record: the tab's that shows it, or the one it opens as. */
  documentCarrying({ formKey, plugin }: EditAddress): Promise<RecordDocument> {
    for (const [panel, copy] of this.shown) {
      if (this.deps.activeRecordTracker.formKeyOf(panel) === formKey && samePluginAddress(copy.plugin, plugin)) {
        return Promise.resolve({ uri: copy.uri });
      }
    }
    return copyDocument(this.deps.client, { formKey, plugin });
  }

  /** Each file's tab a move takes along shows, where it lands, the record it showed, or the one the
   *  edit moved it to, with the same columns and place. Answers what undoes that for a move not made. */
  moving(moves: readonly SourceMove[], edited: EditAddress, newFormKey: string | undefined): () => void {
    const landings: string[] = [];
    for (const [panel, { uri, plugin }] of this.shown) {
      const to = movedTo(uri, moves);
      const formKey = this.deps.activeRecordTracker.formKeyOf(panel);
      if (uri.scheme !== 'file' || to === uri || !formKey) continue;
      const kept = { plugin, columns: this.deps.editsInFlight.columnsOf(panel), place: this.places.get(panel) };
      const rekeyed = newFormKey !== undefined && formKey === edited.formKey && samePluginAddress(plugin, edited.plugin);
      this.moved.set(to.toString(), rekeyed ? { ...kept, formKey: newFormKey, from: formKey } : { ...kept, formKey });
      landings.push(to.toString());
    }
    return () => { for (const landing of landings) this.moved.delete(landing); };
  }

  async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    const key = document.uri.toString();
    const columns = this.columnsToShow.get(key) ?? [];
    this.columnsToShow.delete(key);
    this.documentOf.set(panel, key);
    panel.onDidDispose(() => this.documentOf.delete(panel));
    if (document.uri.scheme === RENDERED_DOCUMENT_SCHEME) {
      const { formKey, plugin } = copyOf(document.uri);
      const documentText = (pluginActive: boolean) => Promise.resolve(pluginActive ? undefined : document.getText());
      this.show(panel, document.uri, { formKey, columns }, { titleFromRead: () => undefined, plugin, documentText });
      return;
    }
    if (document.uri.scheme === CHILD_RECORD_SCHEME) {
      // The file is the container's, so its name is not the child's.
      const { formKey, plugin } = copyOf(document.uri);
      panel.title = recordTitle(formKey, undefined);
      this.showFile(panel, document, { formKey, plugin }, columns, (read, titled) => { panel.title = recordTitle(read, titled, plugin); });
      return;
    }
    const moved = this.moved.get(key);
    if (moved) {
      this.moved.delete(key);
      this.showFile(panel, document, moved, moved.columns, () => undefined, moved.place);
      if (moved.from) this.deps.editsInFlight.moved(panel, moved.plugin, moved.from, moved.formKey);
      return;
    }
    const { fsPath } = document.uri;
    let shownReason: string | undefined;
    const read = async (): Promise<void> => {
      try {
        const { formKey, ...copy } = await this.deps.client.getRecordOfFile(fsPath);
        if (this.unread.delete(panel)) this.showFile(panel, document, { formKey, plugin: pluginAddressOf(copy) }, columns, () => undefined);
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

  // Saved, the read model wins (commands.md, Principles), but mEdit compares no inactive plugin's
  // copy, nor a record an edit moved before mEdit reports it, so the file's column reads the document then.
  private showFile(
    panel: vscode.WebviewPanel, document: vscode.TextDocument, { formKey, plugin }: RecordCopy, columns: readonly RecordCopy[],
    titleFromRead: TabDocument['titleFromRead'], place?: ViewState,
  ): void {
    const documentText = async (pluginActive: boolean) => {
      if (document.isDirty || this.deps.editsInFlight.waitingFor(panel)) return document.getText();
      return pluginActive ? undefined : savedText(document.uri);
    };
    this.show(panel, document.uri, { formKey, columns, place }, { titleFromRead, plugin, documentText });
    const following = vscode.workspace.onDidChangeTextDocument((change) => {
      if (change.document === document && change.contentChanges.length > 0) this.deps.editsInFlight.refresh(panel);
    });
    panel.onDidDispose(() => { following.dispose(); });
  }

  private show(panel: vscode.WebviewPanel, uri: vscode.Uri, page: GridPage, tab: Omit<TabDocument, 'keepViewState'>): void {
    this.shown.set(panel, { uri, plugin: tab.plugin });
    panel.onDidDispose(() => { this.shown.delete(panel); this.places.delete(panel); });
    showRecord(this.deps, panel, uri, page, { ...tab, keepViewState: (place) => { this.places.set(panel, place); } });
  }
}

// The file on disk, as VS Code misses a write to a file outside the workspace while its tab is
// hidden. A document's text has no byte order mark. A file gone is mEdit's to answer.
async function savedText(uri: vscode.Uri): Promise<string | undefined> {
  try {
    return (await fileText(uri)).replace(/^\uFEFF/, '');
  } catch (err) {
    if (err instanceof vscode.FileSystemError && err.code === 'FileNotFound') return undefined;
    throw err;
  }
}

function showRecord(
  deps: ShowRecordDeps, panel: vscode.WebviewPanel, document: vscode.Uri, { formKey, columns, place }: GridPage, tab: TabDocument,
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

  // A reply and a follow reach the one panel that asked, never a broadcast.
  const panelRouterDeps = routerDepsForPanel(routerDeps, panel, focusedCells, editsInFlight, tab, document.toString());
  panel.webview.onDidReceiveMessage((msg: unknown) => { void routeRecordPanelMessage(msg, panelRouterDeps); });

  showWebviewPage(panel.webview, context.extensionUri, {
    script: 'main.js', globals: { mEditFormKey: formKey, mEditColumns: columns, ...(place && { mEditViewState: place }) },
  });
}

export function registerEditorCommands(deps: EditorCommandDeps): vscode.Disposable[] {
  const {
    context, recordPanels, activeRecordTracker, editsInFlight, focusedCells, meditClient,
    outputChannel,
  } = deps;
  // Lives for the activation, disposed with the editor commands.
  const loadOrderStatusTracker = trackLoadOrderStatus(
    meditClient, () => announceConflictsComputed(recordPanels, editsInFlight));
  // The picker and the panel's name are each panel's own, added per panel below.
  const routerDeps: SharedRecordPanelDeps = {
    meditClient, channel: outputChannel, reporter: deps.reporterFor('recordPanel'),
    conflictsComputed: () => loadOrderStatusTracker.current(), loadFailures: () => loadOrderStatusTracker.failures(),
  };
  const providerDeps = { context, recordPanels, activeRecordTracker, editsInFlight, focusedCells, routerDeps };
  const recordEditorProvider = new RecordEditorProvider({ ...providerDeps, client: meditClient, channel: outputChannel });
  const writeDeps: RecordWriteDeps = {
    meditClient,
    documentOf: (address) => recordEditorProvider.documentCarrying(address),
    moving: (moves, edited, newFormKey) => recordEditorProvider.moving(moves, edited, newFormKey),
    oneAtATime: oneAtATime(),
    refreshSourceControlFor: (plugin) => { deps.refreshSourceControlFor(plugin); },
    // Surfaces a refused edit (ADR-0019).
    reporter: deps.reporterFor('recordPanel'),
  };
  const commitDeps: FieldCommitDeps = {
    editGateOf: (address) => editsInFlight.gateShowing(recordPanels, address),
    edit: (address, envelope) => applyRecordEdit(writeDeps, address, envelope),
  };
  const extendedFields = new ExtendedFieldDocuments({
    client: meditClient, reporter: deps.reporterFor('extendedField'),
    commit: (field, value) => commitField(commitDeps, field, value),
  });
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
      if (plan.addresses.length > 0) return openRecords(meditClient, reporter, recordEditorProvider, plan);
      if (argument !== undefined) {
        reporter.report('error', 'Could not open a record.', 'What was given names no record.');
        return;
      }
      const formKey = await pickRecord({ meditClient, reporter }, '', []);
      if (formKey) await openRecords(meditClient, reporter, recordEditorProvider, { addresses: [{ formKey }], placement: 'active', preview: true });
    }),
    vscode.commands.registerCommand('modbench.record.openToSide', (row?: unknown, selection?: unknown) =>
      vscode.commands.executeCommand('modbench.record.open', besideArgument(row, selection))),
  ];
}

type OpenClient = Pick<MEditClient, 'getRecordOwner' | 'getRecordFile' | 'getRecordOfFile' | 'getRenderedDocument'>;

// Several records open one grid: the first record's document, with the others as its columns
// (editor.md, Opening, story 4).
async function openRecords(
  client: OpenClient, reporter: Reporter, grid: Pick<RecordEditorProvider, 'open'>,
  { addresses: [first, ...others], placement, preview }: RecordOpenPlan,
): Promise<void> {
  if (!first) return;
  const failMessage = `Failed to open "${recordTitle(first.formKey, undefined)}".`;
  await reportFailure(reporter, failMessage, async () => {
    const tab = await recordDocument(client, first) ?? noActivePluginHolds(first.formKey);
    if ('refused' in tab) {
      reporter.report('error', failMessage, tab.refused);
      return;
    }
    const columns: RecordCopy[] = [];
    for (const other of others) {
      const copy = await copyToOpen(client, other);
      if ('refused' in copy) {
        reporter.report('error', failMessage, copy.refused);
        return;
      }
      columns.push(copy);
    }
    const show = (options: vscode.TextDocumentShowOptions) => grid.open(tab.uri, columns, options);
    if (typeof placement !== 'object') {
      await show({ viewColumn: placement === 'beside' ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active, preview });
      return;
    }
    const replaced = recordTabAt(placement);
    await (replaced ? inTabsPlace(replaced, show) : show({ viewColumn: placement.viewColumn }));
  });
}

const recordTabAt = ({ document, viewColumn }: TabPlace): vscode.Tab | undefined =>
  vscode.window.tabGroups.all.find((group) => group.viewColumn === viewColumn)?.tabs.find(({ input }) =>
    input instanceof vscode.TabInputCustom && input.viewType === RECORD_VIEW_TYPE && input.uri.toString() === document);

const noActivePluginHolds = (formKey: string) => ({ refused: `No active plugin holds ${formKey}.` });

// A record given without a plugin is its winning copy.
async function copyToOpen(client: OpenClient, { formKey, plugin }: RecordToOpen): Promise<RecordCopy | { refused: string }> {
  const owner = plugin ?? await client.getRecordOwner(formKey);
  return owner ? { formKey, plugin: owner } : noActivePluginHolds(formKey);
}

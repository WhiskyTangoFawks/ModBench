import * as vscode from 'vscode';
import type { MEditClient } from '../client';
import { samePluginAddress, type PluginAddress } from '../wire/pluginAddress';
import { reportFailure } from '../drivingLib/reportFailure';
import { pickRecord } from './recordPicker';
import type { SharedRecordPanelDeps } from './recordPanelMessageRouter';
import type { RecordTabs } from './recordTabs';
import { RECORD_VIEW_TYPE, RecordEditorProvider, recordTabAt } from './recordPanelHost';
import { applyRecordEdit, oneAtATime, type RecordWriteDeps } from './applyRecordEdit';
import { ExtendedFieldDocuments } from './extendedFieldEditor';
import { commitField, registerRecordPanelContextCommands, type FieldCommitDeps } from './recordPanelContextCommands';
import { registerGridKeyCommands } from './gridKeyCommands';
import {
  registerRecordLifecycleCommands, registerRecordCopyCommands, type ViewSelections,
} from './recordLifecycleCommands';
import { announceConflictsComputed, subscribeRecordTabsToNotifications } from './notificationWiring';
import type { RecordWrite } from '../drivingLib/writingGesture';
import type { Reporter } from '../ports/reporter';
import type { AskQuestion } from '../ports/dialog';
import { besideArgument, recordOpenPlan, type RecordOpenPlan, type RecordToOpen } from './recordOpenPlan';
import { recordTitle } from './recordTitle';
import { inTabsPlace } from './inTabsPlace';
import { followReportedCopies } from './recordCopy';
import { RenderedDocuments } from './renderedDocument';
import { ChildRecordDocuments } from './childRecordDocument';
import { recordDocument, type RecordCopy } from '../drivingLib/recordDocument';
import type { ModFacts } from './modsByOrigin';

export interface EditorCommandDeps {
  context: Pick<vscode.ExtensionContext, 'extensionUri'>;
  // The open record tabs and the one in focus, whose record the Referenced By view retargets from,
  // not from a command argument.
  tabs: RecordTabs;
  meditClient: Pick<MEditClient,
    | 'getEditChanges' | 'searchRecords'
    | 'deleteRecords' | 'copyRecords'
    | 'getPlugins' | 'getRecordHolders'
    | 'getComparison' | 'getRecordsComparison' | 'onNotification' | 'loadOrderStatus' | 'onLoadOrderStatusChanged' | 'onReconnected' | 'getRecordOwner'
    | 'getRecordFile' | 'getRecordOfFile' | 'getRenderedDocument'>;
  // The rows selected in the view the user last selected in, which a palette entry acts on.
  focusedViewSelection: () => readonly unknown[];
  // The rows selected in the view `view` names, which a key bound in that view acts on.
  selectionOf: (view: string) => readonly unknown[];
  recordWrite: RecordWrite;
  // The plugin's Source Control status, which a committed field edit redrives, lives on the session
  // object, narrowed to a callback like focusedViewSelection.
  refreshSourceControlFor: (plugin: PluginAddress) => void;
  // The instance's mods, which a column header reads for its mod's repository state.
  modFacts: ModFacts;
  outputChannel: Pick<vscode.LogOutputChannel, 'debug' | 'info' | 'warn'>;
  // Kernel ports the composition root implements (target-architecture.d2, Ports).
  reporterFor: (tag: string) => Reporter;
  ask: AskQuestion;
}

export function registerEditorCommands(deps: EditorCommandDeps): vscode.Disposable[] {
  const { context, tabs, meditClient, outputChannel } = deps;
  const selections: ViewSelections = { focused: deps.focusedViewSelection, of: deps.selectionOf };
  // The picker and the title are each tab's own, which the record grid adds per tab.
  const routerDeps: SharedRecordPanelDeps = {
    meditClient, channel: outputChannel, reporter: deps.reporterFor('recordPanel'),
    conflictsComputed: () => meditClient.loadOrderStatus?.conflictsComputed ?? false,
    loadFailures: () => meditClient.loadOrderStatus?.failures ?? [],
    modFacts: deps.modFacts,
  };
  const recordEditorProvider = new RecordEditorProvider({ context, tabs, routerDeps, client: meditClient, channel: outputChannel });
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
    editGateOf: (address) => tabs.gateShowing(address),
    edit: (address, envelope) => applyRecordEdit(writeDeps, address, envelope),
  };
  const extendedFields = new ExtendedFieldDocuments({
    client: meditClient, reporter: deps.reporterFor('extendedField'),
    commit: (field, value) => commitField(commitDeps, field, value),
  });
  const keepsItsPlace = { webviewOptions: { retainContextWhenHidden: true } };

  return [
    { dispose: subscribeRecordTabsToNotifications(meditClient, tabs) },
    extendedFields,
    new RenderedDocuments(meditClient),
    new ChildRecordDocuments(meditClient),
    { dispose: meditClient.onLoadOrderStatusChanged(() => { announceConflictsComputed(tabs); }) },
    vscode.window.registerCustomEditorProvider(RECORD_VIEW_TYPE, recordEditorProvider, keepsItsPlace),
    { dispose: meditClient.onNotification('load-order-status', () => { recordEditorProvider.readAgain(); }) },
    // A report names the records that changed, and a move of any of them can move a child's carrier.
    followReportedCopies(meditClient, (affects) => { void recordEditorProvider.followCarried(affects); },
      ({ plugin }) => (copy) => samePluginAddress(copy.plugin, plugin)),
    // The native right-click menus write from here directly, with no panel in the path — the same
    // write deps the router has, plus the extended-field documents.
    ...registerRecordPanelContextCommands({
      ...commitDeps, extendedFields,
      focusedCell: () => tabs.focusedCell(),
    }),
    ...registerGridKeyCommands({
      focusedCell: () => tabs.focusedCell(),
      tellFocusedPanel: (message) => { tabs.activeTab()?.post(message); },
    }),
    ...registerRecordLifecycleCommands(
      meditClient, deps.reporterFor('recordLifecycle'), deps.ask, selections, deps.recordWrite),
    ...registerRecordCopyCommands(
      meditClient, deps.reporterFor('recordCopy'), deps.ask, selections, deps.recordWrite),
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

const noActivePluginHolds = (formKey: string) => ({ refused: `No active plugin holds ${formKey}.` });

// A record given without a plugin is its winning copy.
async function copyToOpen(client: OpenClient, { formKey, plugin }: RecordToOpen): Promise<RecordCopy | { refused: string }> {
  const owner = plugin ?? await client.getRecordOwner(formKey);
  return owner ? { formKey, plugin: owner } : noActivePluginHolds(formKey);
}

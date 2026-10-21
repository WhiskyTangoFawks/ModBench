import * as vscode from 'vscode';
import type { MEditClient } from '../client';
import { argumentOfKind, registerAgentGesture, type AgentGesture, type GestureResult } from '../drivingLib/agentGesture';
import type { KindedRow } from '../drivingLib/gestureEntry';
import { Refusal } from '../drivingLib/refusal';
import { errorMessage } from '../ports/errorMessage';
import { pickRecord } from './recordPicker';
import type { SharedRecordPanelDeps } from './recordPanelMessageRouter';
import type { RecordTabs } from './recordTabs';
import { RECORD_VIEW_TYPE, RecordEditorProvider } from './recordPanelHost';
import { applyRecordEdit, type RecordWriteDeps } from './applyRecordEdit';
import { ExtendedFieldDocuments } from './extendedFieldEditor';
import { commitField, registerRecordPanelContextCommands, type FieldCommitDeps } from './recordPanelContextCommands';
import { registerGridKeyCommands } from './gridKeyCommands';
import {
  registerRecordLifecycleCommands, registerRecordCopyCommands, type ViewSelections,
} from './recordLifecycleCommands';
import { announceConflictsComputed, subscribeRecordTabsToNotifications } from './notificationWiring';
import { recordWriteOver } from '../drivingLib/recordWrite';
import type { Instance } from '../instanceLoader/instance';
import type { SourceEditing } from '../textDocuments/sourceEditing';
import type { Reporter } from '../ports/reporter';
import type { AskQuestion } from '../ports/dialog';
import { pinnedArgument, recordOpenPlan, type RecordOpenPlan, type RecordToOpen } from './recordOpenPlan';
import { recordTitle } from './recordTitle';
import { followCopiesIntoDocuments } from './copyFollowers';
import { RenderedDocuments } from './renderedDocument';
import { ChildRecordDocuments } from '../textDocuments/childRecordDocument';
import { holdOneTextPerFile } from '../textDocuments/oneTextPerFile';
import { copyDocument } from '../textDocuments/recordDocument';
import type { RecordCopy } from '../wire/recordCopy';
import type { ModFacts } from './modsByOrigin';
import type { LoadOrderComing } from './loadOrderComing';
import { failureReason, isReadFailed } from '../wire/readFailed';

export interface EditorCommandDeps {
  loadOrderComing: LoadOrderComing;
  context: Pick<vscode.ExtensionContext, 'extensionUri'>;
  // The open record tabs and the one in focus, whose record the Referenced By view retargets from,
  // not from a command argument.
  tabs: RecordTabs;
  meditClient: Pick<MEditClient,
    | 'getEditChanges' | 'searchRecords'
    | 'getDeleteChanges' | 'getCopyChanges'
    | 'getPlugins' | 'getRecordHolders'
    | 'getComparison' | 'getRecordsComparison' | 'onNotification' | 'loadOrderStatus' | 'onLoadOrderSettled' | 'getRecordOwner'
    | 'latestLoadOrder' | 'getCopyDocument' | 'getRecordOfFile' | 'getRenderedDocument'>;
  // The rows selected in the view the user last selected in, which a palette entry acts on.
  focusedViewSelection: () => readonly unknown[];
  // The rows selected in the view `view` names, which a key bound in that view acts on.
  selectionOf: (view: string) => readonly unknown[];
  recordWriteProgressView: string;
  instance: Pick<Instance, 'refresh'>;
  sourceEditing: SourceEditing;
  // The instance's mods, which a column header reads for its mod's repository state.
  modFacts: ModFacts;
  outputChannel: Pick<vscode.LogOutputChannel, 'debug' | 'info' | 'warn' | 'error'>;
  // Kernel ports the composition root implements (target-architecture.d2, Ports).
  reporterFor: (tag: string) => Reporter;
  ask: AskQuestion;
}

export function registerEditorCommands(deps: EditorCommandDeps): vscode.Disposable[] {
  const { context, tabs, meditClient, outputChannel } = deps;
  const recordWrite = recordWriteOver(deps.recordWriteProgressView, deps.instance, meditClient);
  const selections: ViewSelections = { focused: deps.focusedViewSelection, of: deps.selectionOf };
  // The picker and the title are each tab's own, which the record grid adds per tab.
  const routerDeps: SharedRecordPanelDeps = {
    meditClient, channel: outputChannel, reporter: deps.reporterFor('recordPanel'),
    conflictsComputed: () => meditClient.loadOrderStatus?.conflictsComputed ?? false,
    loadOrderComing: () => deps.loadOrderComing.now(),
    loadFailures: () => meditClient.loadOrderStatus?.failures ?? [],
    modFacts: deps.modFacts,
  };
  const recordEditorProvider = new RecordEditorProvider({ context, tabs, routerDeps, client: meditClient, channel: outputChannel });
  const writeDeps: RecordWriteDeps = {
    meditClient,
    documentOf: (address) => recordEditorProvider.documentCarrying(address),
    moving: (moves, edited, newFormKey) => recordEditorProvider.moving(moves, edited, newFormKey),
    oneAtATime: deps.sourceEditing.oneAtATime,
    refreshSourceControlFor: deps.sourceEditing.refreshSourceControlFor,
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
  const childRecordDocuments = new ChildRecordDocuments();
  const editorOptions = { webviewOptions: { retainContextWhenHidden: true, enableFindWidget: true } };

  return [
    { dispose: subscribeRecordTabsToNotifications(meditClient, tabs) },
    extendedFields,
    new RenderedDocuments(meditClient),
    childRecordDocuments,
    holdOneTextPerFile(outputChannel),
    { dispose: meditClient.onLoadOrderSettled(() => { announceConflictsComputed(tabs); }) },
    vscode.window.registerCustomEditorProvider(RECORD_VIEW_TYPE, recordEditorProvider, editorOptions),
    { dispose: meditClient.onNotification('load-order-status', () => { recordEditorProvider.readAgain(); }) },
    deps.loadOrderComing.onChanged(() => { recordEditorProvider.readAgain(); }),
    followCopiesIntoDocuments(meditClient, childRecordDocuments, recordEditorProvider),
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
      meditClient, deps.reporterFor('recordLifecycle'), deps.ask, selections, recordWrite, deps.sourceEditing),
    ...registerRecordCopyCommands(
      meditClient, deps.reporterFor('recordCopy'), deps.ask, selections, recordWrite, deps.sourceEditing),
    registerAgentGesture('modbench.record.open', () => [], recordOpenGesture(meditClient, deps.reporterFor('recordOpen'), recordEditorProvider, deps.focusedViewSelection)),
    vscode.commands.registerCommand('modbench.record.openPinned', (row?: unknown, selection?: unknown) =>
      vscode.commands.executeCommand('modbench.record.open', pinnedArgument(row, selection))),
  ];
}

type OpenClient = Pick<MEditClient, 'getRecordOwner' | 'getCopyDocument'>;

function recordOpenGesture(
  client: OpenClient & Pick<MEditClient, 'searchRecords'>, reporter: Reporter, grid: Pick<RecordEditorProvider, 'open'>,
  focusedViewSelection: () => readonly unknown[],
): AgentGesture<KindedRow, RecordOpenPlan, OpenOutcome, { pinned?: boolean }> {
  return {
    fromView: async (_entry, _option, argument) => {
      const plan = recordOpenPlan(argument, focusedViewSelection());
      if (plan.addresses.length > 0) return plan;
      if (argument !== undefined) {
        reporter.report('error', 'Could not open a record.', 'What was given names no record.');
        return undefined;
      }
      const formKey = await pickRecord({ meditClient: client, reporter }, '', []);
      return formKey ? { addresses: [{ formKey }], pinned: false } : undefined;
    },
    fromAgent: ({ argument, options }) => {
      if (argument.length === 0) throw new Refusal('modbench.record.open takes at least one record.');
      return {
        addresses: argument.map((record) => argumentOfKind(record, 'record')).map(({ formKey, plugin }) => (plugin ? { formKey, plugin } : { formKey })),
        pinned: options.pinned === true,
      };
    },
    run: (plan) => openRecords(client, grid, plan),
    report: (outcome) => {
      if (!outcome.applied) reporter.report('error', outcome.refusal, outcome.detail);
    },
  };
}

type OpenOutcome = GestureResult<RecordCopy>;

// Several records open one grid: the first record's document, with the others as its columns
// (editor.md, Opening, story 4).
async function openRecords(
  client: OpenClient, grid: Pick<RecordEditorProvider, 'open'>, { addresses, pinned }: RecordOpenPlan,
): Promise<OpenOutcome> {
  const failMessage = `Failed to open "${recordTitle(addresses[0]?.formKey ?? '', undefined)}".`;
  const refused = (detail: string): OpenOutcome => ({ applied: false, refusal: failMessage, detail });
  try {
    const [firstCopy, ...others] = addresses;
    if (!firstCopy) return refused('Nothing was given to open.');
    const head = await copyToOpen(client, firstCopy);
    if ('refused' in head) return refused(head.refused);
    const tab = await copyDocument(client, head);
    if ('refused' in tab) return refused(tab.refused);
    const columns: RecordCopy[] = [];
    for (const other of others) {
      const copy = await copyToOpen(client, other);
      if ('refused' in copy) return refused(copy.refused);
      columns.push(copy);
    }
    await grid.open(tab.uri, columns, { viewColumn: vscode.ViewColumn.Active, preview: !pinned });
    return { applied: true, outcome: { landed: [head, ...columns], refused: [] } };
  } catch (err) {
    return refused(errorMessage(err));
  }
}

const noActivePluginHolds = (formKey: string) => ({ refused: `No active plugin holds ${formKey}.` });

// A record given without a plugin is its winning copy.
async function copyToOpen(client: OpenClient, { formKey, plugin }: RecordToOpen): Promise<RecordCopy | { refused: string }> {
  const owner = plugin ?? await client.getRecordOwner(formKey);
  if (isReadFailed(owner)) return { refused: failureReason(owner) };
  return owner ? { formKey, plugin: owner } : noActivePluginHolds(formKey);
}

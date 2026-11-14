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
import { pinnedArgument, recordOpenPlan, type RecordToOpen } from './recordOpenPlan';
import { recordTitle } from '../drivingLib/recordTitle';
import { followCopiesIntoDocuments } from './copyFollowers';
import { RenderedDocuments } from './renderedDocument';
import { ChildRecordDocuments } from '../textDocuments/childRecordDocument';
import { holdOneTextPerFile } from '../textDocuments/oneTextPerFile';
import { copyDocument } from '../textDocuments/recordDocument';
import type { RecordCopy } from '../wire/recordCopy';
import type { PluginAddress } from '../wire/pluginAddress';
import type { ModFacts } from './modsByOrigin';
import type { LoadOrderComing } from './loadOrderComing';
import { failureReason, isReadFailed } from '../wire/readFailed';

export interface EditorCommandDeps {
  loadOrderComing: LoadOrderComing;
  context: Pick<vscode.ExtensionContext, 'extensionUri'>;
  tabs: RecordTabs;
  meditClient: Pick<MEditClient,
    | 'getEditChanges' | 'searchRecords'
    | 'getDeleteChanges' | 'getCopyChanges'
    | 'getPlugins' | 'getRecordHolders'
    | 'getComparison' | 'getRecordsComparison' | 'onNotification' | 'loadOrderStatus' | 'onLoadOrderSettled' | 'getRecordOwners'
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
  const recordWrite = recordWriteOver(deps.recordWriteProgressView, deps.instance);
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
      meditClient, deps.reporterFor('recordLifecycle'), selections, recordWrite, deps.sourceEditing),
    ...registerRecordCopyCommands(
      meditClient, deps.reporterFor('recordCopy'), deps.ask, selections, recordWrite, deps.sourceEditing),
    registerAgentGesture('modbench.record.open', () => [], recordOpenGesture(meditClient, deps.reporterFor('recordOpen'), recordEditorProvider, deps.focusedViewSelection)),
    vscode.commands.registerCommand('modbench.record.openPinned', (row?: unknown, selection?: unknown) =>
      vscode.commands.executeCommand('modbench.record.open', pinnedArgument(row, selection))),
  ];
}

type OpenClient = Pick<MEditClient, 'getRecordOwners' | 'getCopyDocument'>;

interface RecordsToOpen { copies: RecordCopy[]; pinned: boolean }

const failedToOpen = (formKey: string | undefined): string => `Failed to open "${recordTitle(formKey ?? '', undefined)}".`;

function recordOpenGesture(
  client: OpenClient & Pick<MEditClient, 'searchRecords'>, reporter: Reporter, grid: Pick<RecordEditorProvider, 'open'>,
  focusedViewSelection: () => readonly unknown[],
): AgentGesture<KindedRow, RecordsToOpen, OpenOutcome, { pinned?: boolean }> {
  return {
    fromView: async (_entry, _option, argument) => {
      let plan = recordOpenPlan(argument, focusedViewSelection());
      if (plan.addresses.length === 0) {
        if (argument !== undefined) {
          reporter.report('error', 'Could not open a record.', 'What was given names no record.');
          return undefined;
        }
        const formKey = await pickRecord({ meditClient: client, reporter }, '', []);
        if (!formKey) return undefined;
        plan = { addresses: [{ formKey }], pinned: false };
      }
      const copies = await copiesToOpen(client, plan.addresses, pickOwner);
      if (copies === undefined) return undefined;
      if ('refused' in copies) {
        reporter.report('error', failedToOpen(plan.addresses[0]?.formKey), copies.refused);
        return undefined;
      }
      return { copies, pinned: plan.pinned };
    },
    fromAgent: async ({ argument, options }) => {
      if (argument.length === 0) throw new Refusal('modbench.record.open takes at least one record.');
      const addresses = argument.map((record) => argumentOfKind(record, 'record')).map(({ formKey, plugin }) => (plugin ? { formKey, plugin } : { formKey }));
      const copies = await copiesToOpen<never>(client, addresses, refuseSeveralOwners);
      if ('refused' in copies) throw new Refusal(copies.refused);
      return { copies, pinned: options.pinned === true };
    },
    run: (given) => openRecords(client, grid, given),
    report: (outcome) => {
      if (!outcome.applied) reporter.report('error', outcome.refusal, outcome.detail);
    },
  };
}

type OpenOutcome = GestureResult<RecordCopy>;

// Several records open one grid: the first record's document, with the others as its columns
// (editor.md, Opening, story 4).
async function openRecords(
  client: OpenClient, grid: Pick<RecordEditorProvider, 'open'>, { copies, pinned }: RecordsToOpen,
): Promise<OpenOutcome> {
  const refused = (detail: string): OpenOutcome => ({ applied: false, refusal: failedToOpen(copies[0]?.formKey), detail });
  try {
    const [head, ...columns] = copies;
    if (!head) return refused('Nothing was given to open.');
    const tab = await copyDocument(client, head);
    if ('refused' in tab) return refused(tab.refused);
    await grid.open(tab.uri, columns, { viewColumn: vscode.ViewColumn.Active, preview: !pinned });
    return { applied: true, outcome: { landed: copies, refused: [] } };
  } catch (err) {
    return refused(errorMessage(err));
  }
}

const noActivePluginHolds = (formKey: string) => ({ refused: `No active plugin holds ${formKey}.` });

const pickOwner = async (formKey: string, owners: readonly PluginAddress[]): Promise<PluginAddress | undefined> => (await vscode.window.showQuickPick(
  owners.map((owner) => ({ label: owner.name, description: owner.origin, owner })),
  { placeHolder: `Open ${formKey} from…` }))?.owner;

const refuseSeveralOwners = (formKey: string, owners: readonly PluginAddress[]): Promise<{ refused: string }> => Promise.resolve({
  refused: `No active plugin holds ${formKey}, and several compiled plugins do: ${owners.map(({ name, origin }) => `${name} (${origin})`).join(', ')}. Give the plugin whose copy to open.`,
});

// A record given without a plugin is its owner's copy (editor.md, Opening, story 8); of several owners, `choose` says which,
// as a gesture never guesses (commands.md, Principles).
async function copiesToOpen<Unchosen extends undefined>(
  client: OpenClient, addresses: readonly RecordToOpen[],
  choose: (formKey: string, owners: readonly PluginAddress[]) => Promise<PluginAddress | { refused: string } | Unchosen>,
): Promise<RecordCopy[] | { refused: string } | Unchosen> {
  const copies: RecordCopy[] = [];
  for (const { formKey, plugin } of addresses) {
    const owners = plugin ? [plugin] : await client.getRecordOwners(formKey);
    if (isReadFailed(owners)) return { refused: failureReason(owners) };
    const [only, ...others] = owners;
    if (only === undefined) return noActivePluginHolds(formKey);
    const owner = others.length === 0 ? only : await choose(formKey, owners);
    if (owner === undefined || 'refused' in owner) return owner;
    copies.push({ formKey, plugin: owner });
  }
  return copies;
}

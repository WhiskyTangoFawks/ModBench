import * as vscode from 'vscode';
import { isRefused, type MEditClient, type RecordAddress } from '../client';
import type { ItemRefusal, SelectionOutcome } from '../ports/selectionOutcome';
import { offerEslFlagRemoval } from './eslFlagRemovalPrompt';
import { resolveOrigin } from './resolveOrigin';
import { copyTargetPlugins, type CopyGesture } from './copyTargetPlugins';
import type { Reporter } from '../ports/reporter';
import type { AskQuestion } from '../ports/dialog';
import type { RecordTreeSync } from './onRecordEdited';
import { errorMessage } from '../ports/errorMessage';

/** Read off whatever object a gesture is invoked with — a tree row from the Plugins view or a
 *  plain identity literal, the way `recordOpenIdentity` (recordPanelHost.ts) already reads an
 *  unknown node. Editor names no Plugins-view node type. */
export interface RecordIdentity {
  formKey: string;
  plugin: string;
  origin?: string;
  editorId?: string;
}

export function recordIdentity(arg: unknown): RecordIdentity | undefined {
  if (!arg || typeof arg !== 'object') return undefined;
  const n = arg as {
    record?: { formKey?: string; plugin?: string; editorId?: string | null };
    origin?: string; formKey?: string; plugin?: string; editorId?: string;
  };
  if (n.record) {
    if (!n.record.formKey || !n.record.plugin) return undefined;
    return { formKey: n.record.formKey, plugin: n.record.plugin, origin: n.origin, editorId: n.record.editorId ?? undefined };
  }
  if (!n.formKey || !n.plugin) return undefined;
  return { formKey: n.formKey, plugin: n.plugin, origin: n.origin, editorId: n.editorId };
}

export interface RecordTypeIdentity {
  plugin: string;
  origin?: string;
  recordType: string;
}

export function recordTypeIdentity(arg: unknown): RecordTypeIdentity | undefined {
  if (!arg || typeof arg !== 'object') return undefined;
  const n = arg as { plugin?: string; origin?: string; recordType?: string };
  if (!n.plugin || !n.recordType) return undefined;
  return { plugin: n.plugin, origin: n.origin, recordType: n.recordType };
}

// A node's own `origin` when the row already carries it (ADR-0012), else derived from
// `getPlugins()`; reports and returns undefined when neither answers.
function makeResolveOriginOrReport(
  client: Pick<MEditClient, 'getPlugins'>, outputChannel: vscode.LogOutputChannel, reporter: Reporter,
): (node: { origin?: string; pluginName: string }) => Promise<string | undefined> {
  return async (node) => {
    const origin = node.origin ?? await resolveOrigin(client, node.pluginName, (msg) => outputChannel.info(msg));
    if (!origin) {
      reporter.report('error', `Could not resolve which mod "${node.pluginName}" belongs to.`);
    }
    return origin;
  };
}

// The plugin and its origin as well as the record: the same FormKey can sit in two copies of one
// plugin (ADR-0012), and the question must say which.
function recordLabel(record: RecordIdentity): string {
  const named = record.editorId ? `${record.editorId} [${record.formKey}]` : record.formKey;
  const where = record.origin ? `${record.plugin} (${record.origin})` : record.plugin;
  return `${named} in ${where}`;
}

function askToDelete(records: readonly RecordIdentity[], ask: AskQuestion): PromiseLike<string | undefined> {
  const [only] = records;
  if (records.length === 1 && only) {
    return ask(
      `Delete ${recordLabel(only)}? It leaves its plugin source as a working-tree change you can review.`,
      { modal: true }, 'Delete');
  }
  return ask(
    `Delete ${records.length} records? They leave their plugin source as working-tree changes you can review.`,
    { modal: true, detail: records.map(recordLabel).join('\n') },
    'Delete',
  );
}

function selectedRecords(clicked: unknown, selected: readonly unknown[] | undefined): RecordIdentity[] {
  const nodes: readonly unknown[] = selected?.length ? selected : [clicked];
  return nodes.map(recordIdentity).filter((i): i is RecordIdentity => i !== undefined);
}

const UNRESOLVED_ORIGIN = 'could not resolve which mod it belongs to';

// A record whose mod cannot be named is refused here and writes nothing; the rest still go.
async function addressRecords(
  records: readonly RecordIdentity[], resolve: (plugin: string) => Promise<string | undefined>,
): Promise<{ addressed: { record: RecordIdentity; address: RecordAddress }[]; unaddressed: ItemRefusal<RecordIdentity>[] }> {
  const addressed: { record: RecordIdentity; address: RecordAddress }[] = [];
  const unaddressed: ItemRefusal<RecordIdentity>[] = [];
  for (const record of records) {
    const origin = record.origin ?? await resolve(record.plugin);
    if (origin) addressed.push({ record, address: { formKey: record.formKey, plugin: record.plugin, origin } });
    else unaddressed.push({ item: record, reason: UNRESOLVED_ORIGIN });
  }
  return { addressed, unaddressed };
}

type RecordLifecycleClient = Pick<MEditClient,
  | 'createRecord' | 'deleteRecords' | 'getPlugins'
  // `editRecord`: create's own ESL-flag-removal retry (`offerEslFlagRemoval`), not a record write
  // of its own.
  | 'editRecord'>;

/** ADR-0018: xEdit hosts Add and Remove in its tree's context menu, not the grid, and the titles
 *  match its captions exactly. No ambient fallback is worth a QuickPick, so both are palette-gated. */
export function registerRecordLifecycleCommands(
  client: RecordLifecycleClient, outputChannel: vscode.LogOutputChannel,
  reporter: Reporter, ask: AskQuestion,
  treeSync: RecordTreeSync, refreshMatchingPlugins: () => void,
): vscode.Disposable[] {
  const resolveOriginOrReport = makeResolveOriginOrReport(client, outputChannel, reporter);
  // A create or delete landed: the same re-derive every write in this file needs
  // (plugins.md) — a changed record can start or stop matching the active filter.
  const onWritten = () => { treeSync.refresh(); refreshMatchingPlugins(); };

  return [
    // xEdit's own "Add": no prompt — a blank record appears immediately and is named afterward
    // by editing its EditorID, matching xEdit's own gesture.
    vscode.commands.registerCommand('modbench.record.create', async (arg?: unknown) => {
      const identity = recordTypeIdentity(arg);
      if (!identity) return;
      const origin = await resolveOriginOrReport({ origin: identity.origin, pluginName: identity.plugin });
      if (!origin) return;

      const result = await client.createRecord(
        identity.plugin, origin, identity.recordType, undefined, undefined,
        message => offerEslFlagRemoval({ name: identity.plugin, origin }, message, 'Create the Record', client, ask, reporter),
      );
      if (!result) return; // the ESL prompt was declined — nothing happened
      if (isRefused(result)) { reporter.report('error', result.message); return; }
      onWritten();
      reporter.landed(`Added ${result.formKey}.`);
    }),

    // Asked once for the whole selection and naming each record, so the user confirms the right thing.
    vscode.commands.registerCommand('modbench.record.delete', async (clicked?: unknown, selected?: unknown[]) => {
      const identities = selectedRecords(clicked, selected);
      if (identities.length === 0) return;
      if (await askToDelete(identities, ask) !== 'Delete') return;

      const { addressed, unaddressed } = await addressRecords(
        identities, (plugin) => resolveOrigin(client, plugin, (msg) => outputChannel.info(msg)));
      const answer = addressed.length > 0
        ? await client.deleteRecords(addressed.map((a) => a.address)) : { landed: [], refused: [] };
      if (isRefused(answer)) { reporter.report('error', answer.message); return; }
      if (answer.landed.length > 0) onWritten();
      const outcome: SelectionOutcome<RecordIdentity> = {
        landed: answer.landed, refused: [...unaddressed, ...answer.refused],
      };
      reporter.selectionOutcome(
        `Could not remove ${outcome.refused.length} of ${identities.length} records.`, outcome, recordLabel);
    }),
  ];
}

type RecordCopyClient = Pick<MEditClient,
  'copyRecordAsOverride' | 'copyRecordAsNewRecord' | 'getPlugins' | 'getRecordOverridePlugins' | 'editRecord'>;

// Returns the picked `PluginMetadata`, not just its name, so the caller reads `.origin` off it
// instead of a second round trip. Either call rejecting is caught wholesale: no fallback tier
// remains below this step.
async function pickCopyDestination(
  client: RecordCopyClient, gesture: CopyGesture, formKey: string, reporter: Reporter,
): Promise<{ name: string; origin: string } | undefined> {
  try {
    const allPlugins = await client.getPlugins();
    const carrying = gesture === 'copy-as-override' ? await client.getRecordOverridePlugins(formKey) : [];
    const candidates = copyTargetPlugins(allPlugins, gesture, carrying);
    if (candidates.length === 0) {
      // Nothing landed, but the reporter's information tier is `landed`: an unusable gesture says
      // so at the same level it always has, rather than toasting a warning the user cannot act on.
      reporter.landed('No eligible destination plugin for this copy.');
      return undefined;
    }
    const items = candidates.map((p) => ({ label: p.name, description: `[${p.loadOrderIndex}]`, plugin: p }));
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: gesture === 'copy-as-override' ? 'Copy as Override Into…' : 'Copy as New Record Into…',
    });
    return picked && { name: picked.plugin.name, origin: picked.plugin.origin };
  } catch (error) {
    reporter.report('error', 'Could not look up destination plugins.', errorMessage(error));
    return undefined;
  }
}

// No confirmation modal: xEdit's CopyInto asks nothing before an override copy, and Copy as New
// Record prompts for neither an EditorID nor a FormKey. No free FormID refuses plainly, with no
// flag-removal retry unlike create.
async function runCopyRecordCommand(
  gesture: CopyGesture, arg: unknown, client: RecordCopyClient,
  resolveOriginOrReport: (node: { origin?: string; pluginName: string }) => Promise<string | undefined>,
  reporter: Reporter,
  onWritten: () => void,
): Promise<void> {
  const identity = recordIdentity(arg);
  if (!identity) return;
  const sourceOrigin = await resolveOriginOrReport({ origin: identity.origin, pluginName: identity.plugin });
  if (!sourceOrigin) return;

  const destination = await pickCopyDestination(client, gesture, identity.formKey, reporter);
  if (!destination) return;

  if (gesture === 'copy-as-override') {
    const result = await client.copyRecordAsOverride(identity.formKey, identity.plugin, sourceOrigin, destination.name, destination.origin);
    if (!result) return;
    if (isRefused(result)) { reporter.report('error', result.message); return; }
    onWritten();
    reporter.landed(`Copied ${identity.formKey} into ${destination.name}.`);
  } else {
    const result = await client.copyRecordAsNewRecord(
      identity.formKey, identity.plugin, sourceOrigin, destination.name, destination.origin, undefined,
    );
    if (!result) return;
    if (isRefused(result)) { reporter.report('error', result.message); return; }
    onWritten();
    reporter.landed(`Copied as ${result.newFormKey} into ${destination.name}.`);
  }
}

// xEdit parity (xeMainForm.pas's CopyInto): one command per gesture, reached from a tree row or
// a column header alike — `arg` resolves to the same identity either way.
export function registerRecordCopyCommands(
  client: RecordCopyClient, outputChannel: vscode.LogOutputChannel,
  reporter: Reporter,
  treeSync: RecordTreeSync, refreshMatchingPlugins: () => void,
): vscode.Disposable[] {
  const resolveOriginOrReport = makeResolveOriginOrReport(client, outputChannel, reporter);
  // A copy lands as a working-tree change on the destination plugin — same reason create
  // and delete re-derive the tree and the filter's matching-plugin set.
  const onWritten = () => { treeSync.refresh(); refreshMatchingPlugins(); };

  return [
    vscode.commands.registerCommand('modbench.record.copyAsOverride', async (arg?: unknown) => {
      await runCopyRecordCommand('copy-as-override', arg, client, resolveOriginOrReport, reporter, onWritten);
    }),
    vscode.commands.registerCommand('modbench.record.copyAsNewRecord', async (arg?: unknown) => {
      await runCopyRecordCommand('copy-as-new', arg, client, resolveOriginOrReport, reporter, onWritten);
    }),
  ];
}

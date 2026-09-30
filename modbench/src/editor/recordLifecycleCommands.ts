import * as vscode from 'vscode';
import { isRefused, type CopyItem, type CopyMode, type MEditClient, type PluginAddress, type RecordAddress } from '../client';
import { COPY_MODE_ITEMS, copiesWritten, copyDestinationItems, heldCopies, type CopyDestinationItem } from './copyPicks';
import type { Reporter } from '../ports/reporter';
import type { AskQuestion } from '../ports/dialog';
import { errorMessage } from '../ports/errorMessage';

/** Read off whatever object a gesture is invoked with — a tree row from the Plugins view or a
 *  plain identity literal, the way `recordOpenIdentity` (recordPanelHost.ts) already reads an
 *  unknown node. Editor names no Plugins-view node type. */
export interface RecordIdentity {
  formKey: string;
  plugin: string;
  origin: string;
  editorId?: string;
}

export function recordIdentity(arg: unknown): RecordIdentity | undefined {
  if (!arg || typeof arg !== 'object') return undefined;
  const n = arg as {
    record?: { formKey?: string; plugin?: string; editorId?: string | null };
    origin?: string; formKey?: string; plugin?: string; editorId?: string;
  };
  if (!n.origin) return undefined;
  if (n.record) {
    if (!n.record.formKey || !n.record.plugin) return undefined;
    return { formKey: n.record.formKey, plugin: n.record.plugin, origin: n.origin, editorId: n.record.editorId ?? undefined };
  }
  if (!n.formKey || !n.plugin) return undefined;
  return { formKey: n.formKey, plugin: n.plugin, origin: n.origin, editorId: n.editorId };
}

function recordName(formKey: string, editorId: string | undefined): string {
  return editorId ? `${editorId} [${formKey}]` : formKey;
}

// The plugin and its origin as well as the record: the same FormKey can sit in two plugins that
// share a filename (ADR-0012), and the question must say which.
function recordLabel(record: RecordIdentity): string {
  return `${recordName(record.formKey, record.editorId)} in ${record.plugin} (${record.origin})`;
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

function addressOf({ formKey, plugin, origin }: RecordIdentity): RecordAddress {
  return { formKey, plugin, origin };
}

type RecordLifecycleClient = Pick<MEditClient, 'deleteRecords'>;

/** ADR-0018: xEdit hosts its Remove in its tree's context menu, not the grid. */
export function registerRecordLifecycleCommands(
  client: RecordLifecycleClient, reporter: Reporter, ask: AskQuestion,
  // The palette hands no row, so delete takes the Plugins selection.
  viewSelection: () => readonly unknown[],
): vscode.Disposable[] {
  return [
    // Asked once for the whole selection and naming each record, so the user confirms the right thing.
    vscode.commands.registerCommand('modbench.record.delete', async (clicked?: unknown, selected?: unknown[]) => {
      const identities = clicked === undefined ? selectedRecords(undefined, viewSelection()) : selectedRecords(clicked, selected);
      if (identities.length === 0) return;
      if (await askToDelete(identities, ask) !== 'Delete') return;

      const answer = await client.deleteRecords(identities.map(addressOf));
      if (isRefused(answer)) { reporter.report('error', answer.message); return; }
      reporter.selectionOutcome(
        `Could not delete ${answer.refused.length} of ${identities.length} records.`, answer, recordLabel);
    }),
  ];
}

type RecordCopyClient = Pick<MEditClient, 'copyRecords' | 'getPlugins' | 'getRecordHolders'>;

async function pickCopyMode(): Promise<CopyMode | undefined> {
  const picked = await vscode.window.showQuickPick(COPY_MODE_ITEMS, { placeHolder: 'Copy as' });
  return picked?.mode;
}

// A pick left with nothing picked is Esc by another route: nothing is copied and nothing said.
async function pickCopyDestinations(
  client: RecordCopyClient, mode: CopyMode, records: readonly RecordAddress[], reporter: Reporter,
): Promise<PluginAddress[] | undefined> {
  let items: CopyDestinationItem[];
  try {
    items = copyDestinationItems(await client.getPlugins(), mode, records);
  } catch (error) {
    reporter.report('error', 'Could not look up the plugins to copy into.', errorMessage(error));
    return undefined;
  }
  if (items.length === 0) {
    reporter.landed('No plugin can take the copy: Track a plugin to edit it.');
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Copy into', canPickMany: true });
  return picked?.length ? picked.map((item) => item.plugin) : undefined;
}

// What an override would replace, asked of mEdit once per record before anything is written.
async function copiesAnOverrideReplaces(
  client: RecordCopyClient, records: readonly RecordAddress[], destinations: readonly PluginAddress[],
): Promise<CopyItem[]> {
  const holders = new Map<string, PluginAddress[]>();
  for (const formKey of new Set(records.map((r) => r.formKey))) {
    holders.set(formKey, await client.getRecordHolders(formKey));
  }
  return heldCopies(records, destinations, holders);
}

function addressLabel(record: RecordAddress, editorIds: ReadonlyMap<string, string | undefined>): string {
  return recordLabel({ ...record, editorId: editorIds.get(record.formKey) });
}

function askToReplace(
  held: readonly CopyItem[], editorIds: ReadonlyMap<string, string | undefined>, ask: AskQuestion,
): PromiseLike<string | undefined> {
  const named = ({ record, destination }: CopyItem) =>
    `${recordName(record.formKey, editorIds.get(record.formKey))} in ${destination.name} (${destination.origin})`;
  const question = held.length === 1
    ? 'Replace the copy a destination already holds?'
    : `Replace the ${held.length} copies the destinations already hold?`;
  return ask(
    `${question} The replacement is a working-tree change you can review.`,
    { modal: true, detail: held.map(named).join('\n') },
    'Replace',
  );
}

// The replace Option an override is sent with: false when no destination holds a copy, true once
// the replacement is confirmed, and undefined when nothing is to be copied.
async function confirmReplacement(
  client: RecordCopyClient, records: readonly RecordAddress[], destinations: readonly PluginAddress[],
  editorIds: ReadonlyMap<string, string | undefined>, ask: AskQuestion, reporter: Reporter,
): Promise<boolean | undefined> {
  let held: CopyItem[];
  try {
    held = await copiesAnOverrideReplaces(client, records, destinations);
  } catch (error) {
    reporter.report('error', 'Could not check which plugins already hold a copy.', errorMessage(error));
    return undefined;
  }
  if (held.length === 0) return false;
  return await askToReplace(held, editorIds, ask) === 'Replace' ? true : undefined;
}

function landedMessage(landed: readonly CopyItem[], editorIds: ReadonlyMap<string, string | undefined>): string {
  const [only] = landed;
  if (landed.length === 1 && only) {
    const { formKey } = only.record;
    return `Copied ${recordName(formKey, editorIds.get(formKey))} into ${only.destination.name}.`;
  }
  return `Made ${landed.length} copies.`;
}

/** plugins.md, Pickers, Copy: the mode, then the destinations, then one question when an override
 *  would replace copies the destinations already hold (commands.md, Confirm what destroys). */
export function registerRecordCopyCommands(
  client: RecordCopyClient, reporter: Reporter, ask: AskQuestion,
  // The palette hands no row, so copy takes the Plugins selection.
  viewSelection: () => readonly unknown[],
): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('modbench.record.copy', async (clicked?: unknown, selected?: unknown[]) => {
      const identities = clicked === undefined ? selectedRecords(undefined, viewSelection()) : selectedRecords(clicked, selected);
      if (identities.length === 0) return;
      const records = identities.map(addressOf);
      const editorIds = new Map(identities.map((i) => [i.formKey, i.editorId]));

      const mode = await pickCopyMode();
      if (!mode) return;
      const destinations = await pickCopyDestinations(client, mode, records, reporter);
      if (!destinations) return;

      const replace = mode === 'Override'
        ? await confirmReplacement(client, records, destinations, editorIds, ask, reporter)
        : false;
      if (replace === undefined) return;

      const answer = await client.copyRecords(records, mode, destinations, replace);
      if (isRefused(answer)) { reporter.report('error', answer.message); return; }
      const written = copiesWritten(answer.landed, mode);
      if (written.length > 0) reporter.landed(landedMessage(written, editorIds));
      const into = (item: CopyItem) =>
        `${addressLabel(item.record, editorIds)} into ${item.destination.name} (${item.destination.origin})`;
      reporter.selectionOutcome(
        `Could not make ${answer.refused.length} of ${written.length + answer.refused.length} copies.`,
        answer, into);
    }),
  ];
}

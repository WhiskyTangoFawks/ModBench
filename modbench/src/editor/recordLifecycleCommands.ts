import * as vscode from 'vscode';
import { isRefused, type CopyItem, type CopyMode, type MEditClient, type PluginAddress, type RecordAddress } from '../client';
import type { ItemRefusal, SelectionOutcome } from '../ports/selectionOutcome';
import { resolveOrigin } from './resolveOrigin';
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

/** What create is invoked on: a plugin, and the record type when the caller names it. */
export interface CreateTarget {
  plugin: string;
  origin?: string;
  recordType?: string;
}

/** A group row, or a literal an agent or a key passes. A plugin row states its plugin as an
 *  entry, not a name, so its surface reads it. */
export function createTargetOf(arg: unknown): CreateTarget | undefined {
  if (!arg || typeof arg !== 'object') return undefined;
  const n = arg as { plugin?: unknown; origin?: string; recordType?: string };
  if (typeof n.plugin !== 'string' || !n.plugin) return undefined;
  return { plugin: n.plugin, origin: n.origin, recordType: n.recordType };
}

/** A record create wrote, which the view selects once the watch lists it. */
export interface CreatedRecord {
  plugin: string;
  origin: string;
  recordType: string;
  formKey: string;
}

/** The view create is offered on: its own rows as the Argument, and the row of a new record. */
export interface CreateSurface {
  surfaceTarget(clicked: unknown, selected: readonly unknown[] | undefined): CreateTarget | undefined;
  selectWhenListed(record: CreatedRecord): void;
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

function recordName(formKey: string, editorId: string | undefined): string {
  return editorId ? `${editorId} [${formKey}]` : formKey;
}

// The plugin and its origin as well as the record: the same FormKey can sit in two plugins that
// share a filename (ADR-0012), and the question must say which.
function recordLabel(record: RecordIdentity): string {
  const where = record.origin ? `${record.plugin} (${record.origin})` : record.plugin;
  return `${recordName(record.formKey, record.editorId)} in ${where}`;
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

type RecordCreateClient = Pick<MEditClient, 'createRecord' | 'getCreatableRecordTypes' | 'getPlugins'>;

// Esc on the pick is a pick left with nothing: nothing is created and nothing said.
async function pickRecordType(client: RecordCreateClient, reporter: Reporter): Promise<string | undefined> {
  let items: (vscode.QuickPickItem & { type: string })[];
  try {
    items = (await client.getCreatableRecordTypes()).map(({ type, displayName }) => ({ label: displayName, description: type, type }));
  } catch (error) {
    reporter.report('error', 'Could not look up the record types to create.', errorMessage(error));
    return undefined;
  }
  return (await vscode.window.showQuickPick(items, { placeHolder: 'Record type' }))?.type;
}

/** ADR-0018: xEdit hosts its Add in its tree's context menu. As xEdit's, the new record is blank
 *  and named afterward by editing its EditorID. */
export function registerRecordCreateCommand(
  client: RecordCreateClient, outputChannel: vscode.LogOutputChannel, reporter: Reporter, surface: CreateSurface,
): vscode.Disposable {
  const resolveOriginOrReport = makeResolveOriginOrReport(client, outputChannel, reporter);
  return vscode.commands.registerCommand('modbench.record.create', async (clicked?: unknown, selected?: readonly unknown[]) => {
    const target = createTargetOf(clicked) ?? surface.surfaceTarget(clicked, selected);
    if (!target) return;
    const origin = await resolveOriginOrReport({ origin: target.origin, pluginName: target.plugin });
    if (!origin) return;
    const recordType = target.recordType ?? await pickRecordType(client, reporter);
    if (!recordType) return;

    const result = await client.createRecord(target.plugin, origin, recordType);
    if (isRefused(result)) { reporter.report('error', result.message); return; }
    reporter.landed(`Created ${result.formKey}.`);
    surface.selectWhenListed({ plugin: target.plugin, origin, recordType: result.recordType, formKey: result.formKey });
  });
}

type RecordLifecycleClient = Pick<MEditClient, 'deleteRecords' | 'getPlugins'>;

/** ADR-0018: xEdit hosts its Remove in its tree's context menu, not the grid. */
export function registerRecordLifecycleCommands(
  client: RecordLifecycleClient, outputChannel: vscode.LogOutputChannel,
  reporter: Reporter, ask: AskQuestion,
  // The palette hands no row, so delete takes the Plugins selection.
  viewSelection: () => readonly unknown[],
): vscode.Disposable[] {
  return [
    // Asked once for the whole selection and naming each record, so the user confirms the right thing.
    vscode.commands.registerCommand('modbench.record.delete', async (clicked?: unknown, selected?: unknown[]) => {
      const identities = clicked === undefined ? selectedRecords(undefined, viewSelection()) : selectedRecords(clicked, selected);
      if (identities.length === 0) return;
      if (await askToDelete(identities, ask) !== 'Delete') return;

      const { addressed, unaddressed } = await addressRecords(
        identities, (plugin) => resolveOrigin(client, plugin, (msg) => outputChannel.info(msg)));
      const answer = addressed.length > 0
        ? await client.deleteRecords(addressed.map((a) => a.address)) : { landed: [], refused: [] };
      if (isRefused(answer)) { reporter.report('error', answer.message); return; }
      const outcome: SelectionOutcome<RecordIdentity> = {
        landed: answer.landed, refused: [...unaddressed, ...answer.refused],
      };
      reporter.selectionOutcome(
        `Could not delete ${outcome.refused.length} of ${identities.length} records.`, outcome, recordLabel);
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
  client: RecordCopyClient, outputChannel: vscode.LogOutputChannel,
  reporter: Reporter, ask: AskQuestion,
  // The palette hands no row, so copy takes the Plugins selection.
  viewSelection: () => readonly unknown[],
): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('modbench.record.copy', async (clicked?: unknown, selected?: unknown[]) => {
      const identities = clicked === undefined ? selectedRecords(undefined, viewSelection()) : selectedRecords(clicked, selected);
      if (identities.length === 0) return;
      const { addressed, unaddressed } = await addressRecords(
        identities, (plugin) => resolveOrigin(client, plugin, (msg) => outputChannel.info(msg)));
      const reportUnaddressed = () => reporter.selectionOutcome(
        `Could not copy ${unaddressed.length} of ${identities.length} records.`, { landed: [], refused: unaddressed }, recordLabel);
      const records = addressed.map((a) => a.address);
      if (records.length === 0) { reportUnaddressed(); return; }
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
      reportUnaddressed();
    }),
  ];
}

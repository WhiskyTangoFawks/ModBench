import * as vscode from 'vscode';
import { isRefused, type CopyItem, type CopyMode, type MEditClient, type PluginAddress, type RecordAddress } from '../client';
import { copyModeItems, copiesWritten, copyDestinationItems, heldChildren, heldCopies, isOverride, recordsAskedToReplace, runsUnderPluginsBar, withoutDestinations, type CopyDestinationItem } from './copyPicks';
import type { Reporter } from '../ports/reporter';
import type { ItemRefusal } from '../ports/selectionOutcome';
import type { AskQuestion } from '../ports/dialog';
import { errorMessage } from '../ports/errorMessage';
import type { RecordWrite } from '../drivingLib/writingGesture';
import { ReferencedByHolderNode, REFERENCED_BY_VIEW } from './ReferencedByTreeProvider';

// Read off whatever object a gesture is invoked with — a tree row from the Plugins view or a
// plain identity literal. Editor names no Plugins-view node type.
interface RecordArgument {
  formKey: string;
  plugin: string;
  origin?: string;
  editorId?: string;
}

function recordArgument(arg: unknown): RecordArgument | undefined {
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

function recordName(formKey: string, editorId: string | undefined): string {
  return editorId ? `${editorId} [${formKey}]` : formKey;
}

// The question names the origin too, so it says which plugin of the filename it means (ADR-0012).
function recordLabel({ formKey, editorId, plugin, origin }: RecordArgument): string {
  return `${recordName(formKey, editorId)} in ${origin === undefined ? plugin : `${plugin} (${origin})`}`;
}

function askToDelete(labels: readonly string[], ask: AskQuestion): PromiseLike<string | undefined> {
  const [only] = labels;
  if (labels.length === 1 && only) {
    return ask(`Delete ${only}? It leaves its plugin source as a working-tree change you can review.`, { modal: true }, 'Delete');
  }
  return ask(
    `Delete ${labels.length} records? They leave their plugin source as working-tree changes you can review.`,
    { modal: true, detail: labels.join('\n') },
    'Delete',
  );
}

// An argument that states no origin is refused rather than resolved (ADR-0012).
const NO_ORIGIN = 'it states no origin';

interface Selection {
  records: RecordAddress[];
  originless: ItemRefusal<RecordArgument>[];
  editorIds: ReadonlyMap<string, string | undefined>;
  /** The bar a write runs under: Referenced By's when its rows were the gesture's, else the write's own default. */
  invokedFrom: string | undefined;
}

function selectedRecords(clicked: unknown, selected: readonly unknown[] | undefined): Selection {
  const nodes: readonly unknown[] = selected?.length ? selected : [clicked];
  const named = nodes.map(recordArgument).filter((a): a is RecordArgument => a !== undefined);
  const records: RecordAddress[] = [];
  const originless: ItemRefusal<RecordArgument>[] = [];
  for (const { formKey, plugin, origin, editorId } of named) {
    if (origin === undefined) originless.push({ item: { formKey, plugin, editorId }, reason: NO_ORIGIN });
    else records.push({ formKey, plugin, origin });
  }
  return {
    records, originless, editorIds: new Map(named.map((a) => [a.formKey, a.editorId])),
    invokedFrom: nodes.some((node) => node instanceof ReferencedByHolderNode) ? REFERENCED_BY_VIEW : undefined,
  };
}

type RecordLifecycleClient = Pick<MEditClient, 'deleteRecords'>;

export function registerRecordLifecycleCommands(
  client: RecordLifecycleClient, reporter: Reporter, ask: AskQuestion,
  // The palette hands no row, so it takes the selection of the view last selected in.
  viewSelection: () => readonly unknown[],
  write: RecordWrite,
): vscode.Disposable[] {
  return [
    // Asked once for the whole selection and naming each record, so the user confirms the right thing.
    vscode.commands.registerCommand('modbench.record.delete', async (clicked?: unknown, selected?: unknown[]) => {
      const { records, originless, editorIds, invokedFrom } = clicked === undefined
        ? selectedRecords(undefined, viewSelection()) : selectedRecords(clicked, selected);
      const label = (record: RecordArgument) => addressLabel(record, editorIds);
      if (records.length > 0 && await askToDelete(records.map(label), ask) !== 'Delete') return;

      const reportOutcome = async () => {
        const answer = records.length > 0 ? await client.deleteRecords(records) : { landed: [], refused: [] };
        if (isRefused(answer)) { reporter.report('error', answer.message); return; }
        const refused = [...originless, ...answer.refused];
        reporter.selectionOutcome(
          `Could not delete ${refused.length} of ${records.length + originless.length} records.`,
          { landed: answer.landed, refused }, label);
      };
      await (records.length > 0 ? write(reportOutcome, invokedFrom) : reportOutcome());
    }),
  ];
}

/** A key cannot name its view, so `<view id>.deleteHere` fires delete with that view's own
 *  selection, whichever view was selected in last. */
export function registerDeleteHereCommands(
  selections: ReadonlyMap<string, () => readonly unknown[]>,
): vscode.Disposable[] {
  return [...selections].map(([viewId, selection]) =>
    vscode.commands.registerCommand(`${viewId}.deleteHere`, () => {
      const rows = selection();
      if (rows.length > 0) void vscode.commands.executeCommand('modbench.record.delete', rows[0], rows);
    }));
}

type RecordCopyClient = Pick<MEditClient, 'copyRecords' | 'getPlugins' | 'getRecordHolders' | 'getRecordsWithChildren' | 'getChildrenInDestinations'>;

async function recordsWithChildren(
  client: RecordCopyClient, records: readonly RecordAddress[], reporter: Reporter,
): Promise<RecordAddress[] | undefined> {
  try {
    return await client.getRecordsWithChildren(records);
  } catch (error) {
    reporter.report('error', 'Could not look up which records have child records.', errorMessage(error));
    return undefined;
  }
}

async function pickCopyMode(offerDeep: boolean): Promise<CopyMode | undefined> {
  const picked = await vscode.window.showQuickPick(copyModeItems(offerDeep), { placeHolder: 'Copy as' });
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

async function childrenADeepCopyReplaces(
  client: RecordCopyClient, withChildren: readonly RecordAddress[], destinations: readonly PluginAddress[],
): Promise<CopyItem[]> {
  return withChildren.length === 0 ? [] : heldChildren(await client.getChildrenInDestinations(withChildren, destinations));
}

function addressLabel(record: RecordArgument, editorIds: ReadonlyMap<string, string | undefined>): string {
  return recordLabel({ ...record, editorId: editorIds.get(record.formKey) });
}

function askToReplace(
  held: readonly CopyItem[], heldChildRecords: readonly CopyItem[],
  editorIds: ReadonlyMap<string, string | undefined>, ask: AskQuestion,
): PromiseLike<string | undefined> {
  const named = ({ record, destination }: CopyItem) =>
    `${recordName(record.formKey, editorIds.get(record.formKey))} in ${destination.name} (${destination.origin})`;
  const question = heldChildRecords.length > 0
    ? 'Replace what the destinations already hold? Each destination keeps its own copy of a record that has child records.'
    : held.length === 1
      ? 'Replace the copy a destination already holds?'
      : `Replace the ${held.length} copies the destinations already hold?`;
  const detail = [...held.map(named), ...heldChildRecords.map((item) => `${named(item)}, child records`)].join('\n');
  return ask(
    `${question} The replacement is a working-tree change you can review.`,
    { modal: true, detail },
    'Replace',
  );
}

interface Replacement {
  readonly destinations: readonly PluginAddress[];
  readonly replace: boolean;
}

interface CopySelection {
  readonly mode: CopyMode;
  readonly records: readonly RecordAddress[];
  readonly withChildren: readonly RecordAddress[];
}

async function confirmReplacement(
  client: RecordCopyClient, { mode, records, withChildren }: CopySelection, destinations: readonly PluginAddress[],
  editorIds: ReadonlyMap<string, string | undefined>, ask: AskQuestion, reporter: Reporter,
): Promise<Replacement | undefined> {
  const deep = mode === 'DeepOverride';
  let held: CopyItem[];
  let heldChildRecords: CopyItem[] = [];
  try {
    held = await copiesAnOverrideReplaces(client, recordsAskedToReplace(mode, records, withChildren), destinations);
  } catch (error) {
    reporter.report('error', 'Could not check which plugins already hold a copy.', errorMessage(error));
    return undefined;
  }
  try {
    if (deep) heldChildRecords = await childrenADeepCopyReplaces(client, withChildren, destinations);
  } catch (error) {
    reporter.report('error', 'Could not check which plugins already hold child records.', errorMessage(error));
    return undefined;
  }
  if (held.length + heldChildRecords.length === 0) return { destinations, replace: false };
  if (await askToReplace(held, heldChildRecords, editorIds, ask) === 'Replace') return { destinations, replace: true };
  if (!deep) return undefined;
  const kept = withoutDestinations(destinations, [...held, ...heldChildRecords]);
  return kept.length > 0 ? { destinations: kept, replace: false } : undefined;
}

function landedMessage(landed: readonly CopyItem[], editorIds: ReadonlyMap<string, string | undefined>): string {
  const [only] = landed;
  if (landed.length === 1 && only) {
    const { formKey } = only.record;
    return `Copied ${recordName(formKey, editorIds.get(formKey))} into ${only.destination.name}.`;
  }
  return `Made ${landed.length} copies.`;
}

/** plugins.md, Pickers, Copy: the mode, then the destinations, then one question when the copy
 *  would replace what the destinations already hold (commands.md, Confirm what destroys). */
export function registerRecordCopyCommands(
  client: RecordCopyClient, reporter: Reporter, ask: AskQuestion,
  // The palette hands no row, so it takes the selection of the view last selected in.
  viewSelection: () => readonly unknown[],
  write: RecordWrite,
): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('modbench.record.copy', async (clicked?: unknown, selected?: unknown[]) => {
      const { records, originless, editorIds, invokedFrom } = clicked === undefined
        ? selectedRecords(undefined, viewSelection()) : selectedRecords(clicked, selected);
      const reportOriginless = () => reporter.selectionOutcome(
        `Could not copy ${originless.length} of ${records.length + originless.length} records.`,
        { landed: [], refused: originless }, (record) => addressLabel(record, editorIds));
      if (records.length === 0) { reportOriginless(); return; }

      const withChildren = await recordsWithChildren(client, records, reporter);
      if (!withChildren) return;
      const mode = await pickCopyMode(withChildren.length > 0);
      if (!mode) return;
      const destinations = await pickCopyDestinations(client, mode, records, reporter);
      if (!destinations) return;

      const confirmed = isOverride(mode)
        ? await confirmReplacement(client, { mode, records, withChildren }, destinations, editorIds, ask, reporter)
        : { destinations, replace: false };
      if (!confirmed) return;

      await write(async () => {
        const answer = await client.copyRecords(records, mode, confirmed.destinations, confirmed.replace);
        if (isRefused(answer)) { reporter.report('error', answer.message); return; }
        const written = copiesWritten(answer.landed, mode);
        if (written.length > 0) reporter.landed(landedMessage(written, editorIds));
        const into = (item: CopyItem) =>
          `${addressLabel(item.record, editorIds)} into ${item.destination.name} (${item.destination.origin})`;
        reporter.selectionOutcome(
          `Could not make ${answer.refused.length} of ${written.length + answer.refused.length} copies.`,
          answer, into);
        reportOriginless();
      }, runsUnderPluginsBar(mode) ? undefined : invokedFrom);
    }),
  ];
}

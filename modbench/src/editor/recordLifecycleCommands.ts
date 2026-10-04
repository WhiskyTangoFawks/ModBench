import * as vscode from 'vscode';
import { isRefused, type CopyItem, type CopyMode, type MEditClient, type PluginAddress, type RecordAddress } from '../client';
import { COPY_MODE_ITEMS, copiesWritten, copyDestinationItems, heldCopies, type CopyDestinationItem } from './copyPicks';
import type { Reporter } from '../ports/reporter';
import type { ItemRefusal } from '../ports/selectionOutcome';
import type { AskQuestion } from '../ports/dialog';
import { errorMessage } from '../ports/errorMessage';

/** Read off whatever object a gesture is invoked with — a tree row from the Plugins view or a
 *  plain identity literal. Editor names no Plugins-view node type. */
export interface RecordArgument {
  formKey: string;
  plugin: string;
  origin?: string;
  editorId?: string;
}

export function recordArgument(arg: unknown): RecordArgument | undefined {
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
  return { records, originless, editorIds: new Map(named.map((a) => [a.formKey, a.editorId])) };
}

type RecordLifecycleClient = Pick<MEditClient, 'deleteRecords'>;

/** Runs a delete or copy as its view's writing gesture (common.md, A gesture that writes). */
export type RecordWrite = (command: () => Promise<void>) => Promise<void>;

export function registerRecordLifecycleCommands(
  client: RecordLifecycleClient, reporter: Reporter, ask: AskQuestion,
  // The palette hands no row, so it takes the selection of the view last selected in.
  viewSelection: () => readonly unknown[],
  write: RecordWrite,
): vscode.Disposable[] {
  return [
    // Asked once for the whole selection and naming each record, so the user confirms the right thing.
    vscode.commands.registerCommand('modbench.record.delete', async (clicked?: unknown, selected?: unknown[]) => {
      const { records, originless, editorIds } = clicked === undefined
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
      await (records.length > 0 ? write(reportOutcome) : reportOutcome());
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

function addressLabel(record: RecordArgument, editorIds: ReadonlyMap<string, string | undefined>): string {
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

// The copies an override replaces: none when no destination holds a copy, those held once the
// replacement is confirmed, and undefined when nothing is to be copied.
async function confirmReplacement(
  client: RecordCopyClient, records: readonly RecordAddress[], destinations: readonly PluginAddress[],
  editorIds: ReadonlyMap<string, string | undefined>, ask: AskQuestion, reporter: Reporter,
): Promise<CopyItem[] | undefined> {
  let held: CopyItem[];
  try {
    held = await copiesAnOverrideReplaces(client, records, destinations);
  } catch (error) {
    reporter.report('error', 'Could not check which plugins already hold a copy.', errorMessage(error));
    return undefined;
  }
  if (held.length === 0) return held;
  return await askToReplace(held, editorIds, ask) === 'Replace' ? held : undefined;
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
  // The palette hands no row, so it takes the selection of the view last selected in.
  viewSelection: () => readonly unknown[],
  write: RecordWrite,
): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('modbench.record.copy', async (clicked?: unknown, selected?: unknown[]) => {
      const { records, originless, editorIds } = clicked === undefined
        ? selectedRecords(undefined, viewSelection()) : selectedRecords(clicked, selected);
      const reportOriginless = () => reporter.selectionOutcome(
        `Could not copy ${originless.length} of ${records.length + originless.length} records.`,
        { landed: [], refused: originless }, (record) => addressLabel(record, editorIds));
      if (records.length === 0) { reportOriginless(); return; }

      const mode = await pickCopyMode();
      if (!mode) return;
      const destinations = await pickCopyDestinations(client, mode, records, reporter);
      if (!destinations) return;

      const replacing = mode === 'Override'
        ? await confirmReplacement(client, records, destinations, editorIds, ask, reporter)
        : [];
      if (replacing === undefined) return;

      await write(async () => {
        const answer = await client.copyRecords(records, mode, destinations, replacing.length > 0);
        if (isRefused(answer)) { reporter.report('error', answer.message); return; }
        const written = copiesWritten(answer.landed, mode);
        if (written.length > 0) reporter.landed(landedMessage(written, editorIds));
        const into = (item: CopyItem) =>
          `${addressLabel(item.record, editorIds)} into ${item.destination.name} (${item.destination.origin})`;
        reporter.selectionOutcome(
          `Could not make ${answer.refused.length} of ${written.length + answer.refused.length} copies.`,
          answer, into);
        reportOriginless();
      });
    }),
  ];
}

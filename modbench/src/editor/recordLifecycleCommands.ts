import * as vscode from 'vscode';
import {
  isRefused, type CopyItem, type CopyMode, type MEditClient, type PluginAddress, type RecordAddress, type SourceChanges,
  type UnsavedDocument,
} from '../client';
import { copyModeItems, copiesWritten, copyDestinationItems, heldCopies, type CopyDestinationItem } from './copyPicks';
import type { Reporter } from '../ports/reporter';
import type { ItemRefusal } from '../ports/selectionOutcome';
import type { AskQuestion } from '../ports/dialog';
import { errorMessage } from '../ports/errorMessage';
import type { RecordWrite } from '../drivingLib/writingGesture';
import { keyArgsView } from '../drivingLib/copyValue';
import { gestureEntry, isClickedRow } from '../drivingLib/gestureEntry';
import { rowLabelOf, rowNameOf } from '../drivingLib/argument';
import { recordArgumentOf } from '../drivingLib/recordArgument';
import { ReferencedByHolderNode, REFERENCED_BY_VIEW } from './ReferencedByTreeProvider';

function recordName(formKey: string, label: string | undefined): string {
  return label && label !== formKey ? `${label} [${formKey}]` : formKey;
}

// The question names the origin too, so it says which plugin of the filename it means (ADR-0012).
function recordLabel({ formKey, plugin, origin }: RecordAddress, label: string | undefined): string {
  return `${recordName(formKey, label)} in ${plugin} (${origin})`;
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

const NO_RECORD_ARGUMENT = 'it carries no record Argument';
// A record named without its plugin is refused rather than resolved (ADR-0012).
const NO_PLUGIN = 'it names no plugin';

interface Selection {
  records: RecordAddress[];
  unreadable: ItemRefusal<string>[];
  labels: ReadonlyMap<string, string | undefined>;
  /** The bar a write runs under: Referenced By's when its rows were the gesture's, else the write's own default. */
  invokedFrom: string | undefined;
}

/** The selections a gesture falls back on when it is handed no row. */
export interface ViewSelections {
  /** The palette's: the view last selected in. */
  focused: () => readonly unknown[];
  /** A key's: the view it is bound in, which `args.view` names. */
  of: (view: string) => readonly unknown[];
}

function rowsOf(clicked: unknown, selected: readonly unknown[] | undefined, selections: ViewSelections): readonly unknown[] {
  const keyView = keyArgsView(clicked);
  const viewSelection = () => (keyView === undefined ? selections.focused() : selections.of(keyView));
  return gestureEntry(keyView === undefined ? clicked : undefined, selected, viewSelection, isClickedRow).selection;
}

function selectedRecords(nodes: readonly unknown[]): Selection {
  const records: RecordAddress[] = [];
  const unreadable: ItemRefusal<string>[] = [];
  const labels = new Map<string, string | undefined>();
  for (const node of nodes) {
    const argument = recordArgumentOf(node);
    if (argument?.plugin === undefined) {
      unreadable.push({ item: rowNameOf(node), reason: argument === undefined ? NO_RECORD_ARGUMENT : NO_PLUGIN });
      continue;
    }
    records.push({ formKey: argument.formKey, plugin: argument.plugin.name, origin: argument.plugin.origin });
    labels.set(argument.formKey, rowLabelOf(node));
  }
  return {
    records, unreadable, labels,
    invokedFrom: nodes.some((node) => node instanceof ReferencedByHolderNode) ? REFERENCED_BY_VIEW : undefined,
  };
}

function pluginsOf(records: readonly RecordAddress[]): PluginAddress[] {
  const byKey = new Map(records.map(({ plugin, origin }) => [`${origin}\u0000${plugin}`, { name: plugin, origin }]));
  return [...byKey.values()];
}

type RecordLifecycleClient = Pick<MEditClient, 'getDeleteChanges'>;

/** How a delete reaches plugin source: the dirty documents mEdit reads in place of their files, the workspace edit
 *  that makes its answer, and the Source Control panel, which misses the change on its own. */
export interface DeleteDeps {
  unsaved: () => readonly UnsavedDocument[];
  apply: (items: readonly SourceChanges[]) => Promise<void>;
  refreshSourceControlFor: (plugin: PluginAddress) => void;
}

export function registerRecordLifecycleCommands(
  client: RecordLifecycleClient, reporter: Reporter, ask: AskQuestion,
  selections: ViewSelections,
  write: RecordWrite,
  source: DeleteDeps,
): vscode.Disposable[] {
  return [
    // Asked once for the whole selection and naming each record, so the user confirms the right thing.
    vscode.commands.registerCommand('modbench.record.delete', async (clicked?: unknown, selected?: readonly unknown[]) => {
      const { records, unreadable, labels, invokedFrom } = selectedRecords(rowsOf(clicked, selected, selections));
      const label = (item: RecordAddress | string) => (typeof item === 'string' ? item : addressLabel(item, labels));
      if (records.length > 0 && await askToDelete(records.map(label), ask) !== 'Delete') return;

      const reportOutcome = async () => {
        const answer = records.length > 0 ? await client.getDeleteChanges(records, source.unsaved()) : { applied: [], refused: [] };
        if (isRefused(answer)) { reporter.report('error', answer.message); return; }
        try {
          if (answer.applied.length > 0) await source.apply(answer.applied);
        } catch (error) {
          reporter.report('error', 'Could not delete the records.', errorMessage(error));
          return;
        }
        for (const plugin of pluginsOf(answer.applied.map(({ record }) => record))) source.refreshSourceControlFor(plugin);
        const refused = [...unreadable, ...answer.refused];
        reporter.selectionOutcome(
          `Could not delete ${refused.length} of ${records.length + unreadable.length} records.`,
          { landed: answer.applied.map(({ record }) => record), refused }, label);
      };
      await (records.length > 0 ? write(reportOutcome, invokedFrom) : reportOutcome());
    }),
  ];
}

type RecordCopyClient = Pick<MEditClient, 'copyRecords' | 'getPlugins' | 'getRecordHolders'>;

async function pickCopyMode(): Promise<CopyMode | undefined> {
  const picked = await vscode.window.showQuickPick(copyModeItems, { placeHolder: 'Copy as' });
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

function addressLabel(record: RecordAddress, labels: ReadonlyMap<string, string | undefined>): string {
  return recordLabel(record, labels.get(record.formKey));
}

function askToReplace(
  held: readonly CopyItem[], labels: ReadonlyMap<string, string | undefined>, ask: AskQuestion,
): PromiseLike<string | undefined> {
  const named = ({ record, destination }: CopyItem) =>
    `${recordName(record.formKey, labels.get(record.formKey))} in ${destination.name} (${destination.origin})`;
  const question = held.length === 1
    ? 'Replace the copy a destination already holds?'
    : `Replace the ${held.length} copies the destinations already hold?`;
  return ask(
    `${question} The replacement is a working-tree change you can review.`,
    { modal: true, detail: held.map(named).join('\n') },
    'Replace',
  );
}

async function confirmReplacement(
  client: RecordCopyClient, records: readonly RecordAddress[], destinations: readonly PluginAddress[],
  labels: ReadonlyMap<string, string | undefined>, ask: AskQuestion, reporter: Reporter,
): Promise<{ readonly replace: boolean } | 'cancelled'> {
  let held: CopyItem[];
  try {
    held = await copiesAnOverrideReplaces(client, records, destinations);
  } catch (error) {
    reporter.report('error', 'Could not check which plugins already hold a copy.', errorMessage(error));
    return 'cancelled';
  }
  if (held.length === 0) return { replace: false };
  return await askToReplace(held, labels, ask) === 'Replace' ? { replace: true } : 'cancelled';
}

function landedMessage(landed: readonly CopyItem[], labels: ReadonlyMap<string, string | undefined>): string {
  const [only] = landed;
  if (landed.length === 1 && only) {
    const { formKey } = only.record;
    return `Copied ${recordName(formKey, labels.get(formKey))} into ${only.destination.name}.`;
  }
  return `Made ${landed.length} copies.`;
}

/** plugins.md, Pickers, Copy: the mode, then the destinations, then one question when the copy
 *  would replace what the destinations already hold (commands.md, Confirm what destroys). */
export function registerRecordCopyCommands(
  client: RecordCopyClient, reporter: Reporter, ask: AskQuestion,
  selections: ViewSelections,
  write: RecordWrite,
): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('modbench.record.copy', async (clicked?: unknown, selected?: readonly unknown[]) => {
      const { records, unreadable, labels, invokedFrom } = selectedRecords(rowsOf(clicked, selected, selections));
      const reportUnreadable = () => reporter.selectionOutcome(
        `Could not copy ${unreadable.length} of ${records.length + unreadable.length} records.`,
        { landed: [], refused: unreadable }, (name) => name);
      if (records.length === 0) { reportUnreadable(); return; }

      const mode = await pickCopyMode();
      if (!mode) return;
      const destinations = await pickCopyDestinations(client, mode, records, reporter);
      if (!destinations) return;

      const confirmed = mode === 'Override' ? await confirmReplacement(client, records, destinations, labels, ask, reporter) : { replace: false };
      if (confirmed === 'cancelled') return;

      await write(async () => {
        const answer = await client.copyRecords(records, mode, destinations, confirmed.replace);
        if (isRefused(answer)) { reporter.report('error', answer.message); return; }
        const written = copiesWritten(answer.landed, mode);
        if (written.length > 0) reporter.landed(landedMessage(written, labels));
        const into = (item: CopyItem) =>
          `${addressLabel(item.record, labels)} into ${item.destination.name} (${item.destination.origin})`;
        reporter.selectionOutcome(
          `Could not make ${answer.refused.length} of ${written.length + answer.refused.length} copies.`,
          answer, into);
        reportUnreadable();
      }, invokedFrom);
    }),
  ];
}

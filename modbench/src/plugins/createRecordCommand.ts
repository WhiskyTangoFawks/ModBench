import * as vscode from 'vscode';
import { isRefused, type GridPosition, type MEditClient, type PluginAddress, type RecordTypeChoice } from '../client';
import type { Reporter } from '../ports/reporter';
import { errorMessage } from '../ports/errorMessage';
import { registerGesture, singularArgument, type GestureEntry, type RowOf } from '../drivingLib/gestureEntry';
import type { PluginsTreeNode } from './pluginRows';
import type { CreatedRecordWatch, RecordPlace } from './createdRecordSelection';
import type { RecordWrite } from '../drivingLib/writingGesture';
import type { SourceEditing } from '../drivingLib/sourceEditing';
import { applyAnswered } from '../drivingLib/applyAnswered';
import { CREATE_ROW_KINDS, isContainerRow } from './gestureEntry';
import { CELL_RECORD_TYPE } from './RecordBrowser';
import { pluginAddressOf } from '../wire/pluginAddress';
import { recordArgumentOf } from '../drivingLib/recordArgument';
import { answerOf } from '../wire/readFailed';

export interface RecordCreateDeps {
  client: Pick<MEditClient, 'getCreateChanges' | 'getCreatableRecordTypes' | 'getChildRecordTypes'>;
  reporter: Reporter;
  createdRecords: { watch(plugin: PluginAddress): CreatedRecordWatch<PluginsTreeNode> };
  write: RecordWrite;
  source: SourceEditing;
}

type CreateRow = RowOf<PluginsTreeNode, typeof CREATE_ROW_KINDS[number]>;

type Target =
  | { plugin: PluginAddress; recordType: string }
  | { plugin: PluginAddress; container?: string; choices: () => Promise<RecordTypeChoice[]> };

interface Subject {
  readonly label: string;
  readonly placesCells: boolean;
  readonly row?: CreateRow;
}

function createdBeneath(entry: GestureEntry<PluginsTreeNode>, client: RecordCreateDeps['client']): { subject: Subject; target: Target | undefined } | undefined {
  const row = singularArgument(entry, ...CREATE_ROW_KINDS);
  if (row === undefined) return containerOf(entry.clicked ?? entry.focused, client);
  return { subject: { label: labelOf(row), placesCells: row.kind === 'worldspace', row }, target: targetOf(row, client) };
}

// A row of another view that carries a record Argument stands for the container record in its plugin's copy;
// only a worldspace holds a cell.
function containerOf(clicked: unknown, client: RecordCreateDeps['client']): { subject: Subject; target: Target } | undefined {
  const argument = recordArgumentOf(clicked);
  if (argument?.plugin === undefined || !(clicked instanceof vscode.TreeItem)) return undefined;
  const { plugin, formKey } = argument;
  return {
    subject: { label: labelOf(clicked), placesCells: true },
    target: { plugin, container: formKey, choices: async () => answerOf(await client.getChildRecordTypes(plugin, formKey)) },
  };
}

function targetOf(row: CreateRow, client: RecordCreateDeps['client']): Target | undefined {
  if (row.kind === 'plugin') return { plugin: { name: row.plugin.name, origin: row.origin }, choices: async () => answerOf(await client.getCreatableRecordTypes()) };
  if (row.kind === 'recordType') return { plugin: pluginAddressOf(row), recordType: row.recordType };
  if (!isContainerRow(row)) return undefined;
  const [plugin, container] = row.kind === 'record'
    ? [pluginAddressOf({ plugin: row.record.plugin, origin: row.origin }), row.record.formKey]
    : [pluginAddressOf(row), row.formKey];
  return { plugin, container, choices: async () => answerOf(await client.getChildRecordTypes(plugin, container)) };
}

// commands.md, Principles: the gesture asks only for the Options the caller left out.
function optionsOf(option: unknown): { recordType?: string; position?: GridPosition } {
  if (typeof option !== 'object' || option === null) return {};
  const recordType = 'recordType' in option && typeof option.recordType === 'string' ? option.recordType : undefined;
  const position = 'position' in option ? gridPositionOf(option.position) : undefined;
  return { recordType, position };
}

function gridPositionOf(value: unknown): GridPosition | undefined {
  if (typeof value !== 'object' || value === null || !('x' in value) || !('y' in value)) return undefined;
  const { x, y } = value;
  return typeof x === 'number' && typeof y === 'number' && Number.isInteger(x) && Number.isInteger(y) ? { x, y } : undefined;
}

const labelOf = ({ label }: vscode.TreeItem): string => (typeof label === 'object' ? label.label : label ?? '');

async function pickRecordType(
  choices: () => Promise<RecordTypeChoice[]>, holder: string, reporter: Reporter,
): Promise<{ type: string; name: string } | undefined> {
  let items: (vscode.QuickPickItem & { type: string })[];
  try {
    items = (await choices()).map(({ type, displayName }) => ({ label: displayName, description: type, type }));
  } catch (error) {
    reporter.report('error', 'Could not look up the record types to create.', errorMessage(error));
    return undefined;
  }
  const [only, ...rest] = items;
  if (only === undefined) {
    reporter.report('error', `"${holder}" can hold no new record.`);
    return undefined;
  }
  const picked = rest.length === 0 ? only : await vscode.window.showQuickPick(items, { placeHolder: 'Record type' });
  return picked && { type: picked.type, name: picked.label };
}

const GRID_POSITION = /^\s*(-?\d+)\s*,\s*(-?\d+)\s*$/;

async function askGridPosition(): Promise<GridPosition | undefined> {
  const answer = await vscode.window.showInputBox({
    prompt: 'Grid position of the new cell',
    placeHolder: 'x, y',
    validateInput: (value) => (GRID_POSITION.test(value) ? undefined : 'Two whole numbers, as x, y.'),
  });
  const [, x, y] = GRID_POSITION.exec(answer ?? '') ?? [];
  return x === undefined || y === undefined ? undefined : { x: Number(x), y: Number(y) };
}

async function chosenOptions(
  subject: Subject, target: Target, option: unknown, reporter: Reporter,
): Promise<{ recordType: string; typeName: string; position?: GridPosition } | undefined> {
  const given = optionsOf(option);
  const chosen = 'recordType' in target
    ? { type: target.recordType, name: subject.label }
    : given.recordType === undefined
      ? await pickRecordType(target.choices, subject.label, reporter)
      : { type: given.recordType, name: given.recordType };
  if (chosen === undefined) return undefined;
  const { type: recordType, name: typeName } = chosen;
  if (!subject.placesCells || recordType !== CELL_RECORD_TYPE) return { recordType, typeName };
  const position = given.position ?? await askGridPosition();
  return position && { recordType, typeName, position };
}

/** xEdit's Add (plugins.md, Create record). */
export function registerRecordCreateCommand(
  deps: RecordCreateDeps, viewSelection: () => readonly PluginsTreeNode[],
): vscode.Disposable {
  return registerGesture('modbench.record.create', viewSelection, async (entry, option) => {
    const { subject, target } = createdBeneath(entry, deps.client) ?? {};
    if (subject === undefined || target === undefined) return;
    const chosen = await chosenOptions(subject, target, option, deps.reporter);
    if (chosen === undefined) return;

    const { plugin } = target;
    const { recordType, typeName, position } = chosen;
    const container = 'container' in target ? target.container : undefined;
    const place: RecordPlace<PluginsTreeNode> | undefined = container === undefined ? { plugin, recordType } : subject.row && { container: subject.row };
    const created = deps.createdRecords.watch(plugin);
    const answer: { formKey?: string } = {};
    try {
      await deps.write(() => deps.source.oneAtATime(async () => {
        const into = container === undefined ? undefined : { container, position };
        const changes = await deps.client.getCreateChanges(plugin, recordType, into);
        if (isRefused(changes)) {
          deps.reporter.report('error', changes.message);
          return;
        }
        const applied = await applyAnswered(
          deps.source, deps.reporter, [changes], [plugin],
          `Could not create the ${typeName} record.`);
        if (!applied) return;
        answer.formKey = changes.formKey;
        deps.reporter.landed(`Created ${changes.formKey}.`);
      }));
    } finally {
      if (answer.formKey === undefined) created.forget();
      else created.select(place, answer.formKey);
    }
  });
}

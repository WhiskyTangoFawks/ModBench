import * as vscode from 'vscode';
import { isRefused, type GridPosition, type MEditClient, type PluginAddress, type RecordTypeChoice } from '../client';
import type { Reporter } from '../ports/reporter';
import { errorMessage } from '../ports/errorMessage';
import { registerGesture, singularArgument, type RowOf } from '../drivingLib/gestureEntry';
import type { PluginsTreeNode } from './PluginsTreeProvider';
import type { CreatedRecordWatch, RecordPlace } from './createdRecordSelection';
import type { RecordWrite } from '../drivingLib/writingGesture';
import type { SourceEditing } from '../drivingLib/sourceEditing';
import { CREATE_ROW_KINDS, isContainerRow } from './gestureEntry';
import { CELL_RECORD_TYPE } from './RecordBrowser';
import { pluginAddressOf } from '../wire/pluginAddress';

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

function targetOf(row: CreateRow, client: RecordCreateDeps['client']): Target | undefined {
  if (row.kind === 'plugin') return { plugin: { name: row.plugin.name, origin: row.origin }, choices: () => client.getCreatableRecordTypes() };
  if (row.kind === 'recordType') return { plugin: pluginAddressOf(row), recordType: row.recordType };
  if (!isContainerRow(row)) return undefined;
  const [plugin, container] = row.kind === 'record'
    ? [pluginAddressOf({ plugin: row.record.plugin, origin: row.origin }), row.record.formKey]
    : [pluginAddressOf(row), row.formKey];
  return { plugin, container, choices: () => client.getChildRecordTypes(plugin, container) };
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
  row: CreateRow, target: Target, option: unknown, reporter: Reporter,
): Promise<{ recordType: string; typeName: string; position?: GridPosition } | undefined> {
  const given = optionsOf(option);
  const chosen = 'recordType' in target
    ? { type: target.recordType, name: labelOf(row) }
    : given.recordType === undefined
      ? await pickRecordType(target.choices, labelOf(row), reporter)
      : { type: given.recordType, name: given.recordType };
  if (chosen === undefined) return undefined;
  const { type: recordType, name: typeName } = chosen;
  if (row.kind !== 'worldspace' || recordType !== CELL_RECORD_TYPE) return { recordType, typeName };
  const position = given.position ?? await askGridPosition();
  return position && { recordType, typeName, position };
}

/** xEdit's Add (plugins.md, Create record). */
export function registerRecordCreateCommand(
  deps: RecordCreateDeps, viewSelection: () => readonly PluginsTreeNode[],
): vscode.Disposable {
  return registerGesture('modbench.record.create', viewSelection, async (entry, option) => {
    const row = singularArgument(entry, ...CREATE_ROW_KINDS);
    const target = row && targetOf(row, deps.client);
    if (row === undefined || target === undefined) return;
    const chosen = await chosenOptions(row, target, option, deps.reporter);
    if (chosen === undefined) return;

    const { plugin } = target;
    const { recordType, typeName, position } = chosen;
    const container = 'container' in target ? target.container : undefined;
    const place: RecordPlace<PluginsTreeNode> = container === undefined ? { plugin, recordType } : { container: row };
    const created = deps.createdRecords.watch(plugin);
    const answer: { formKey?: string } = {};
    try {
      await deps.write(() => deps.source.oneAtATime(async () => {
        const into = container === undefined ? undefined : { container, position };
        const changes = await deps.client.getCreateChanges(plugin, recordType, deps.source.unsaved(), into);
        if (isRefused(changes)) {
          deps.reporter.report('error', changes.message);
          return;
        }
        let notSaved: readonly string[];
        try {
          notSaved = await deps.source.applyWorkspaceChanges([changes]);
        } catch (error) {
          deps.reporter.report('error', `Could not create the ${typeName} record.`, errorMessage(error));
          return;
        }
        answer.formKey = changes.formKey;
        deps.source.refreshSourceControlFor(plugin);
        if (notSaved.length > 0) deps.reporter.report('error', `Could not save ${changes.formKey}.`, `VS Code did not save ${notSaved.join(', ')}.`);
        deps.reporter.landed(`Created ${changes.formKey}.`);
      }));
    } finally {
      if (answer.formKey === undefined) created.forget();
      else created.select(place, answer.formKey);
    }
  });
}

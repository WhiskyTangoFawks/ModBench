import * as vscode from 'vscode';
import { hasSection, isRecordEditEnvelope, moveEnvelope, type ArrayElementContext, type ArrayParentContext, type ReferenceContext, type StringValueContext } from '../wire/messages';
import type { RecordEditEnvelope } from '../client';
import { pluginAddressOf } from '../wire/pluginAddress';
import { applyRecordEdit, type RecordWriteDeps } from './applyRecordEdit';
import type { ExtendedFieldDocuments, FieldAddress } from './extendedFieldEditor';
import type { EditAddress, EditGate } from './followRecord';
import type { FocusedCellContext } from './focusedCells';

export interface FieldCommitDeps extends RecordWriteDeps {
  // An edit's gate is that of the panels showing the record it is addressed to.
  editGateOf: (address: EditAddress) => EditGate;
}

export interface RecordPanelContextCommandDeps extends FieldCommitDeps {
  // The one set of extended-field documents every panel's tabs open into.
  extendedFields: Pick<ExtendedFieldDocuments, 'open'>;
  // The palette hands a field gesture no cell: it acts on the record tab in focus's focused cell.
  focusedCell: () => FocusedCellContext | undefined;
}

interface ContextCommand {
  command: string;
  run: (deps: RecordPanelContextCommandDeps, ctx: unknown, option: unknown) => Promise<void>;
}

// The `when` clause on each contribution guarantees the shape VS Code hands back — but as
// `unknown`, so each context type carries its own `webviewSection` check rather than a cast.
function hasWebviewSection<Ctx extends { webviewSection: string }>(
  value: unknown, webviewSection: Ctx['webviewSection'],
): value is Ctx {
  return hasSection(value, webviewSection);
}

function isArrayParentContext(value: unknown): value is ArrayParentContext {
  return hasWebviewSection(value, 'arrayParent');
}

function isArrayElementContext(value: unknown): value is ArrayElementContext {
  return hasWebviewSection(value, 'arrayElement');
}

function isReferenceContext(value: unknown): value is ReferenceContext {
  return hasWebviewSection(value, 'reference') && typeof Reflect.get(value, 'referenceTarget') === 'string';
}

function isStringValueContext(value: unknown): value is StringValueContext {
  return hasWebviewSection(value, 'stringValue');
}

function editCommand<Ctx extends { formKey: string; plugin: string; origin: string }>(
  command: string,
  isCtx: (value: unknown) => value is Ctx,
  envelopeOf: (ctx: Ctx, option: unknown) => RecordEditEnvelope | undefined,
): ContextCommand {
  return {
    command,
    run: async (deps, raw, option) => {
      if (!isCtx(raw)) return;
      const envelope = envelopeOf(raw, option);
      if (!envelope) return;
      await deps.editGateOf(raw)(raw, formKey => applyRecordEdit(deps, formKey, pluginAddressOf(raw), envelope));
    },
  };
}

interface PluginCopyAddress { formKey: string; plugin: string; origin: string }

function isPluginCopyAddress(value: unknown): value is PluginCopyAddress {
  if (typeof value !== 'object' || value === null) return false;
  return ['formKey', 'plugin', 'origin'].every(name => typeof Reflect.get(value, name) === 'string');
}

// The grid's edit fires this with the column's plugin copy as the Argument and the value, spelled
// as an envelope, as the Option. From the palette the focused string cell is asked for its new text.
async function editField(deps: RecordPanelContextCommandDeps, address: unknown, option: unknown): Promise<void> {
  if (!isPluginCopyAddress(address)) return;
  const envelope = isRecordEditEnvelope(option) ? option : await promptedSet(address);
  if (!envelope) return;
  await deps.editGateOf(address)(address, formKey => applyRecordEdit(deps, formKey, pluginAddressOf(address), envelope));
}

async function promptedSet(address: object): Promise<RecordEditEnvelope | undefined> {
  if (!isStringValueContext(address)) return undefined;
  const value = await vscode.window.showInputBox({ value: address.value, prompt: address.fieldName });
  return value === undefined ? undefined : { op: 'set', path: address.path, value };
}

// The tab's save posts the `set` an inline edit does, at the row's own path, once per save
// (editor.md, Menus and keys, story 2).
export function commitField(deps: FieldCommitDeps, field: FieldAddress, value: string): Promise<void> {
  return deps.editGateOf(field)(field, formKey =>
    applyRecordEdit(deps, formKey, pluginAddressOf(field), { op: 'set', path: field.path, value }));
}

const CONTEXT_COMMANDS: ContextCommand[] = [
  {
    command: 'modbench.record.openReference',
    run: async (_deps, ctx) => {
      if (isReferenceContext(ctx)) await vscode.commands.executeCommand('modbench.record.open', { formKey: ctx.referenceTarget });
    },
  },
  {
    command: 'modbench.record.openFieldValue',
    run: async (deps, ctx) => { if (isStringValueContext(ctx)) await deps.extendedFields.open(ctx); },
  },
  { command: 'modbench.record.editField', run: editField },
  editCommand('modbench.record.addElement', isArrayParentContext, (ctx, value) => ({ op: 'add', path: ctx.path, value })),
  editCommand('modbench.record.removeElement', isArrayElementContext, ctx => ({ op: 'remove', path: ctx.path })),
  editCommand('modbench.record.moveElementUp', isArrayElementContext, ctx => moveEnvelope(ctx.path, -1)),
  editCommand('modbench.record.moveElementDown', isArrayElementContext, ctx => moveEnvelope(ctx.path, 1)),
];

/** The record panel's native right-click menus. Each command writes from the extension host with
 *  the envelope its own `data-vscode-context` spells, posting nothing into the panel. */
export function registerRecordPanelContextCommands(deps: RecordPanelContextCommandDeps): vscode.Disposable[] {
  return CONTEXT_COMMANDS.map(({ command, run }) =>
    vscode.commands.registerCommand(command, (clicked?: unknown, option?: unknown) => {
      const ctx = clicked ?? deps.focusedCell();
      return ctx ? run(deps, ctx, option) : undefined;
    }),
  );
}

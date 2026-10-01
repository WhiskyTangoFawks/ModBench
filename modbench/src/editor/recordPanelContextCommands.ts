import * as vscode from 'vscode';
import { hasSection, isRecordEditEnvelope, moveEnvelope, type ArrayElementContext, type ArrayParentContext, type ReferenceContext, type StringValueContext } from '../wire/messages';
import type { RecordEditEnvelope } from '../client';
import { applyRecordEdit, type RecordWriteDeps } from './applyRecordEdit';
import { openExtendedFieldEditor, type ExtendedFieldEditorDeps } from './extendedFieldEditor';
import type { EditAddress, EditGate } from './followRecord';
import type { FocusedCellContext } from './focusedCells';

export interface RecordPanelContextCommandDeps extends RecordWriteDeps {
  // Load order-static: the same field files and channel every panel's tabs would get.
  fieldFile: ExtendedFieldEditorDeps['fieldFile'];
  log: (msg: string) => void;
  // An edit's gate is that of the panels showing the record it is addressed to.
  editGateOf: (address: EditAddress) => EditGate;
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
      await deps.editGateOf(raw)(raw, formKey => applyRecordEdit(deps, formKey, raw.plugin, raw.origin, envelope));
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
  await deps.editGateOf(address)(address, formKey => applyRecordEdit(deps, formKey, address.plugin, address.origin, envelope));
}

async function promptedSet(address: object): Promise<RecordEditEnvelope | undefined> {
  if (!isStringValueContext(address)) return undefined;
  const value = await vscode.window.showInputBox({ value: address.value, prompt: address.fieldName });
  return value === undefined ? undefined : { op: 'set', path: address.path, value };
}

// ADR-0018: the tab's save is the same leaf commit an inline edit posts — one `set` at the row's
// own path, as many times as the user saves.
function openStringValueEditor(deps: RecordPanelContextCommandDeps, ctx: StringValueContext): Promise<void> {
  const gate = deps.editGateOf(ctx);
  return openExtendedFieldEditor(
    {
      value: ctx.value, recordLabel: ctx.recordLabel, fieldName: ctx.fieldName,
      plugin: ctx.plugin, origin: ctx.origin, readOnly: ctx.readOnly,
    },
    {
      fieldFile: deps.fieldFile,
      log: deps.log,
      reporter: deps.reporter,
      onCommit: value => gate(ctx, formKey =>
        applyRecordEdit(deps, formKey, ctx.plugin, ctx.origin, { op: 'set', path: ctx.path, value })),
    },
  );
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
    run: async (deps, ctx) => { if (isStringValueContext(ctx)) await openStringValueEditor(deps, ctx); },
  },
  { command: 'modbench.record.editField', run: editField },
  editCommand('modbench.record.addElement', isArrayParentContext, (ctx, value) => ({ op: 'add', path: ctx.path, value })),
  editCommand('modbench.record.removeElement', isArrayElementContext, ctx => ({ op: 'remove', path: ctx.path })),
  editCommand('modbench.record.moveElementUp', isArrayElementContext, ctx => moveEnvelope(ctx.path, -1)),
  editCommand('modbench.record.moveElementDown', isArrayElementContext, ctx => moveEnvelope(ctx.path, 1)),
];

/** The record panel's native right-click menus. Each command writes from the extension host with
 *  the envelope its own `data-vscode-context` spells (ADR-0007), posting nothing into the panel. */
export function registerRecordPanelContextCommands(deps: RecordPanelContextCommandDeps): vscode.Disposable[] {
  return CONTEXT_COMMANDS.map(({ command, run }) =>
    vscode.commands.registerCommand(command, (clicked?: unknown, option?: unknown) => {
      const ctx = clicked ?? deps.focusedCell();
      return ctx ? run(deps, ctx, option) : undefined;
    }),
  );
}

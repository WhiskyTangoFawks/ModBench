import * as vscode from 'vscode';
import { moveEnvelope, type ArrayElementContext, type ArrayParentContext, type StringValueContext } from '../wire/messages';
import type { RecordEditEnvelope } from '../client';
import { applyRecordEdit, type RecordWriteDeps } from './applyRecordEdit';
import { openExtendedFieldEditor, type ExtendedFieldEditorDeps } from './extendedFieldEditor';
import type { EditGate } from './followRecord';

export interface RecordPanelContextCommandDeps extends RecordWriteDeps {
  // Load order-static: the same field files and channel every panel's tabs would get.
  fieldFile: ExtendedFieldEditorDeps['fieldFile'];
  log: (msg: string) => void;
  // A right-click lands on the active record panel, and its edits are that panel's, through its gate.
  editGateOfActivePanel: () => EditGate;
}

interface ContextCommand {
  command: string;
  run: (deps: RecordPanelContextCommandDeps, ctx: unknown) => Promise<void>;
}

// The `when` clause on each contribution guarantees the shape VS Code hands back — but as
// `unknown`, so each context type carries its own `webviewSection` check rather than a cast.
function hasWebviewSection<Ctx extends { webviewSection: string }>(
  value: unknown, webviewSection: Ctx['webviewSection'],
): value is Ctx {
  if (typeof value !== 'object' || value === null) return false;
  return (value as { webviewSection?: unknown }).webviewSection === webviewSection;
}

function isArrayParentContext(value: unknown): value is ArrayParentContext {
  return hasWebviewSection(value, 'arrayParent');
}

function isArrayElementContext(value: unknown): value is ArrayElementContext {
  return hasWebviewSection(value, 'arrayElement');
}

function isStringValueContext(value: unknown): value is StringValueContext {
  return hasWebviewSection(value, 'stringValue');
}

function editCommand<Ctx extends { formKey: string; plugin: string; origin: string }>(
  command: string,
  isCtx: (value: unknown) => value is Ctx,
  envelopeOf: (ctx: Ctx) => RecordEditEnvelope | undefined,
): ContextCommand {
  return {
    command,
    run: async (deps, raw) => {
      if (!isCtx(raw)) return;
      const envelope = envelopeOf(raw);
      if (!envelope) return;
      await deps.editGateOfActivePanel()(raw.formKey, formKey => applyRecordEdit(deps, formKey, raw.plugin, raw.origin, envelope));
    },
  };
}

// ADR-0018: the tab's save is the same leaf commit an inline edit posts — one `set` at the row's
// own path, as many times as the user saves.
function openStringValueEditor(deps: RecordPanelContextCommandDeps, ctx: StringValueContext): Promise<void> {
  // Taken when the menu is used, not at a save, when another panel may be active.
  const gate = deps.editGateOfActivePanel();
  return openExtendedFieldEditor(
    {
      value: ctx.value, recordLabel: ctx.recordLabel, fieldName: ctx.fieldName,
      plugin: ctx.plugin, origin: ctx.origin, readOnly: ctx.readOnly,
    },
    {
      fieldFile: deps.fieldFile,
      log: deps.log,
      reporter: deps.reporter,
      onCommit: value => gate(ctx.formKey, formKey =>
        applyRecordEdit(deps, formKey, ctx.plugin, ctx.origin, { op: 'set', path: ctx.path, value })),
    },
  );
}

const CONTEXT_COMMANDS: ContextCommand[] = [
  {
    command: 'modbench.record.openFieldValue',
    run: async (deps, ctx) => { if (isStringValueContext(ctx)) await openStringValueEditor(deps, ctx); },
  },
  editCommand('modbench.record.addElement', isArrayParentContext, ctx => ({ op: 'add', path: ctx.path })),
  editCommand('modbench.record.removeElement', isArrayElementContext, ctx => ({ op: 'remove', path: ctx.path })),
  editCommand('modbench.record.moveElementUp', isArrayElementContext, ctx => moveEnvelope(ctx.path, -1)),
  editCommand('modbench.record.moveElementDown', isArrayElementContext, ctx => moveEnvelope(ctx.path, 1)),
];

/** The record panel's native right-click menus. Each command writes from the extension host with
 *  the envelope its own `data-vscode-context` spells (ADR-0007), posting nothing into the panel. */
export function registerRecordPanelContextCommands(deps: RecordPanelContextCommandDeps): vscode.Disposable[] {
  return CONTEXT_COMMANDS.map(({ command, run }) =>
    vscode.commands.registerCommand(command, (ctx?: unknown) => (ctx ? run(deps, ctx) : undefined)),
  );
}

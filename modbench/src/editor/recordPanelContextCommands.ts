import * as vscode from 'vscode';
import { moveEnvelope, type ArrayElementContext, type ArrayParentContext, type StringValueContext } from '../wire/messages';
import type { RecordEditEnvelope } from '../client';
import { applyRecordEdit, type RecordWriteDeps } from './applyRecordEdit';
import { openExtendedFieldEditor, type ExtendedFieldEditorDeps } from './extendedFieldEditor';
import type { EditGate } from './followRecord';
import type { FocusedCellContext } from './focusedCells';

export interface RecordPanelContextCommandDeps extends RecordWriteDeps {
  // Load order-static: the same field files and channel every panel's tabs would get.
  fieldFile: ExtendedFieldEditorDeps['fieldFile'];
  log: (msg: string) => void;
  // A right-click's edits are the panel's it came from, through its gate. The panel is named by its
  // webview context's `panelId`, which the body carries.
  editGateOf: (panelId: string | undefined) => EditGate;
  // The palette hands a field gesture no cell: it acts on the record tab in focus's focused cell.
  focusedCell: () => FocusedCellContext | undefined;
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
  // One cell can carry several sections, space-separated, as its menu's `=~` reads them.
  const sections: unknown = Reflect.get(value, 'webviewSection');
  return typeof sections === 'string' && sections.split(' ').includes(webviewSection);
}

function panelIdOf(ctx: object): string | undefined {
  const panelId: unknown = Reflect.get(ctx, 'panelId');
  return typeof panelId === 'string' ? panelId : undefined;
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
      await deps.editGateOf(panelIdOf(raw))(raw, formKey => applyRecordEdit(deps, formKey, raw.plugin, raw.origin, envelope));
    },
  };
}

// ADR-0018: the tab's save is the same leaf commit an inline edit posts — one `set` at the row's
// own path, as many times as the user saves.
function openStringValueEditor(deps: RecordPanelContextCommandDeps, ctx: StringValueContext): Promise<void> {
  const gate = deps.editGateOf(panelIdOf(ctx));
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
    vscode.commands.registerCommand(command, (clicked?: unknown) => {
      const ctx = clicked ?? deps.focusedCell();
      return ctx ? run(deps, ctx) : undefined;
    }),
  );
}

import * as vscode from 'vscode';
import type { ArrayElementContext, ArrayParentContext, RecordEditEnvelope, StringValueContext } from './messages';
import { applyRecordEdit, type RecordWriteDeps } from './applyRecordEdit';
import { openExtendedFieldEditor } from './extendedFieldEditor';

export interface RecordPanelContextCommandDeps extends RecordWriteDeps {
  // Load order-static: the same temp root and channel every panel's tabs would get.
  tempRoot: string;
  log: (msg: string) => void;
}

interface ContextCommand {
  command: string;
  run: (deps: RecordPanelContextCommandDeps, ctx: unknown) => Promise<void>;
}

// The `when` clause on the contribution is what guarantees the shape VS Code hands back as
// `unknown`, so the cast is named once, here.
function edit<Ctx extends { formKey: string; plugin: string; origin: string }>(
  command: string, envelopeOf: (ctx: Ctx) => RecordEditEnvelope | undefined,
): ContextCommand {
  return {
    command,
    run: async (deps, raw) => {
      const ctx = raw as Ctx;
      const envelope = envelopeOf(ctx);
      if (envelope) await applyRecordEdit(deps, ctx.formKey, ctx.plugin, ctx.origin, envelope);
    },
  };
}

// A move's destination is the neighbour's position. Move is offered only where the element's own
// hop is an index, so a key-addressed element resolves to no envelope rather than to a refusal.
function move(ctx: ArrayElementContext, delta: -1 | 1): RecordEditEnvelope | undefined {
  const element = ctx.path.at(-1);
  return element?.kind === 'index'
    ? { op: 'move', path: ctx.path, value: element.index + delta }
    : undefined;
}

// ADR-0039: the tab's save is the same leaf commit an inline edit posts — one `set` at the row's
// own path, as many times as the user saves.
function openStringValueEditor(deps: RecordPanelContextCommandDeps, ctx: StringValueContext): Promise<void> {
  return openExtendedFieldEditor(
    {
      value: ctx.value, recordLabel: ctx.recordLabel, fieldName: ctx.fieldName,
      plugin: ctx.plugin, origin: ctx.origin, readOnly: ctx.readOnly,
    },
    {
      tempRoot: deps.tempRoot,
      log: deps.log,
      reporter: deps.reporter,
      onCommit: value => applyRecordEdit(deps, ctx.formKey, ctx.plugin, ctx.origin, { op: 'set', path: ctx.path, value }),
    },
  );
}

export const RECORD_PANEL_CONTEXT_COMMANDS: ContextCommand[] = [
  {
    command: 'modbench.field.openExtended',
    run: (deps, ctx) => openStringValueEditor(deps, ctx as StringValueContext),
  },
  edit<ArrayParentContext>('modbench.array.add', ctx => ({ op: 'add', path: ctx.path })),
  edit<ArrayElementContext>('modbench.array.remove', ctx => ({ op: 'remove', path: ctx.path })),
  edit<ArrayElementContext>('modbench.array.moveUp', ctx => move(ctx, -1)),
  edit<ArrayElementContext>('modbench.array.moveDown', ctx => move(ctx, 1)),
];

/** The record panel's native right-click menus. Each command writes from the extension host with
 *  the envelope its own `data-vscode-context` spells (ADR-0041), posting nothing into the panel. */
export function registerRecordPanelContextCommands(deps: RecordPanelContextCommandDeps): vscode.Disposable[] {
  return RECORD_PANEL_CONTEXT_COMMANDS.map(({ command, run }) =>
    vscode.commands.registerCommand(command, (ctx?: unknown) => (ctx ? run(deps, ctx) : undefined)),
  );
}

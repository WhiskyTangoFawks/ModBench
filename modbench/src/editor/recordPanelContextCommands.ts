import * as vscode from 'vscode';
import { moveEnvelope, type ArrayElementContext, type ArrayParentContext, type RecordEditEnvelope, type StringValueContext } from '../medit/messages';
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
function editCommand<Ctx extends { formKey: string; plugin: string; origin: string }>(
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

const CONTEXT_COMMANDS: ContextCommand[] = [
  {
    command: 'modbench.field.openExtended',
    run: (deps, ctx) => openStringValueEditor(deps, ctx as StringValueContext),
  },
  editCommand<ArrayParentContext>('modbench.array.add', ctx => ({ op: 'add', path: ctx.path })),
  editCommand<ArrayElementContext>('modbench.array.remove', ctx => ({ op: 'remove', path: ctx.path })),
  editCommand<ArrayElementContext>('modbench.array.moveUp', ctx => moveEnvelope(ctx.path, -1)),
  editCommand<ArrayElementContext>('modbench.array.moveDown', ctx => moveEnvelope(ctx.path, 1)),
];

/** The record panel's native right-click menus. Each command writes from the extension host with
 *  the envelope its own `data-vscode-context` spells (ADR-0041), posting nothing into the panel. */
export function registerRecordPanelContextCommands(deps: RecordPanelContextCommandDeps): vscode.Disposable[] {
  return CONTEXT_COMMANDS.map(({ command, run }) =>
    vscode.commands.registerCommand(command, (ctx?: unknown) => (ctx ? run(deps, ctx) : undefined)),
  );
}

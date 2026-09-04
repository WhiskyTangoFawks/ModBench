import * as vscode from 'vscode';
import {
  EXTENSION_TO_WEBVIEW, type ExtensionToWebview, type ArrayElementContext, type ArrayParentContext,
  type StringValueContext,
} from './messages';
import { broadcastToRecordPanels } from './onRecordEdited';

interface ForwarderCommand {
  command: string;
  build: (ctx: never) => ExtensionToWebview;
}

function forwarder<Ctx>(command: string, build: (ctx: Ctx) => ExtensionToWebview): ForwarderCommand {
  return { command, build };
}

// `rootField`/`path` are forwarded verbatim, never re-derived from the context.
function arrayStructuralOp(
  ctx: ArrayParentContext | ArrayElementContext, op: 'add' | 'remove' | 'moveUp' | 'moveDown',
): ExtensionToWebview {
  return {
    type: EXTENSION_TO_WEBVIEW.ARRAY_STRUCTURAL_OP,
    formKey: ctx.formKey, plugin: ctx.plugin, origin: ctx.origin, rootField: ctx.rootField, path: ctx.path, op,
  };
}

export const FORWARDER_COMMANDS: ForwarderCommand[] = [
  forwarder<StringValueContext>('modbench.field.openExtended', (ctx) => ({
    type: EXTENSION_TO_WEBVIEW.FIELD_OPEN_EXTENDED_EDITOR,
    formKey: ctx.formKey, plugin: ctx.plugin, origin: ctx.origin, fieldName: ctx.fieldName,
    value: ctx.value, readOnly: ctx.readOnly, path: ctx.path, rootField: ctx.rootField,
  })),
  forwarder<ArrayParentContext>('modbench.array.add', (ctx) => arrayStructuralOp(ctx, 'add')),
  forwarder<ArrayElementContext>('modbench.array.remove', (ctx) => arrayStructuralOp(ctx, 'remove')),
  forwarder<ArrayElementContext>('modbench.array.moveUp', (ctx) => arrayStructuralOp(ctx, 'moveUp')),
  forwarder<ArrayElementContext>('modbench.array.moveDown', (ctx) => arrayStructuralOp(ctx, 'moveDown')),
];

/** The extension host holds no reference into an open panel's React state, so these commands
 *  only relay the `data-vscode-context` VS Code hands them; every open panel self-filters on
 *  `formKey` (ADR-0039). */
export function registerForwarderCommands(recordPanels: Set<vscode.WebviewPanel>): vscode.Disposable[] {
  return FORWARDER_COMMANDS.map(({ command, build }) =>
    vscode.commands.registerCommand(command, (ctx?: never) => {
      if (!ctx) return;
      broadcastToRecordPanels(recordPanels, build(ctx));
    }),
  );
}

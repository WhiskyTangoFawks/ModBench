import * as vscode from 'vscode';
import {
  EXTENSION_TO_WEBVIEW, type ExtensionToWebview, type ArrayElementContext, type ArrayParentContext,
  type VmadScriptContext, type VmadPropertyContext, type StringValueContext,
} from './messages';
import { broadcastToRecordPanels } from './onRecordEdited';

/** #630/ADR-0039: the record panel's own right-click commands the extension host cannot resolve
 *  itself — it has no live reference into any open panel's own React state, which alone holds the
 *  record's current values — so each of these only reads the `data-vscode-context` ctx VS Code
 *  parses and hands it, and broadcasts the one matching {@link ExtensionToWebview} message; every
 *  open panel self-filters on `formKey` and applies it (RecordPanel.tsx). One table + one
 *  generic registrar in place of three near-identical hand-written registrars
 *  (`registerFieldOpCommands`/`registerArrayOpCommands`/half of `registerVmadOpCommands`).
 *
 *  Deliberately not every VMAD command: `addScript` (needs a native input box for the new script's
 *  name), `setScriptFlags`/`setPropertyFlags` (need a native QuickPick) and the array/VMAD
 *  gestures that need no message at all all resolve something host-side first, so they stay
 *  hand-written in `extension.ts` alongside this table's own registrar. */
interface ForwarderCommand {
  command: string;
  build: (ctx: never) => ExtensionToWebview;
}

function forwarder<Ctx>(command: string, build: (ctx: Ctx) => ExtensionToWebview): ForwarderCommand {
  return { command, build };
}

// `rootField`/`path` forwarded verbatim from ArrayParentContext/ArrayElementContext — see their
// own doc comments (messages.ts).
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
  forwarder<VmadScriptContext>('modbench.vmad.removeScript', (ctx) => ({
    type: EXTENSION_TO_WEBVIEW.VMAD_STRUCTURAL_OP, formKey: ctx.formKey, plugin: ctx.plugin, origin: ctx.origin,
    fieldPath: `VMAD\\${ctx.scriptName}`, value: { op: 'remove_script' },
  })),
  forwarder<VmadScriptContext>('modbench.vmad.addProperty', (ctx) => ({
    type: EXTENSION_TO_WEBVIEW.VMAD_OPEN_ADD_PROPERTY, formKey: ctx.formKey, plugin: ctx.plugin, origin: ctx.origin,
    scriptName: ctx.scriptName,
  })),
  forwarder<VmadPropertyContext>('modbench.vmad.removeProperty', (ctx) => ({
    type: EXTENSION_TO_WEBVIEW.VMAD_STRUCTURAL_OP, formKey: ctx.formKey, plugin: ctx.plugin, origin: ctx.origin,
    fieldPath: `VMAD\\${ctx.scriptName}\\${ctx.propName}`, value: { op: 'remove_property' },
  })),
];

export function registerForwarderCommands(recordPanels: Set<vscode.WebviewPanel>): vscode.Disposable[] {
  return FORWARDER_COMMANDS.map(({ command, build }) =>
    vscode.commands.registerCommand(command, (ctx?: never) => {
      if (!ctx) return;
      broadcastToRecordPanels(recordPanels, build(ctx));
    }),
  );
}

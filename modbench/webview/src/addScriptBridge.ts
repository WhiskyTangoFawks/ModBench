import { vscode } from './vscode';
import { EXTENSION_TO_WEBVIEW, WEBVIEW_TO_EXTENSION, type ExtensionToWebview } from './messages';

let counter = 0;
const pending = new Map<string, (name: string | null) => void>();

// Issue #212: single shared listener for every in-flight pickScriptName call below — same shape
// as formKeyPickerBridge.ts's listener (#210). The extension host's ADD_SCRIPT_NAME_PICKED reply
// is correlated by requestId, never a broadcast, so this resolves whichever call matches and
// leaves any other in-flight call untouched.
window.addEventListener('message', (event: MessageEvent<unknown>) => {
  const msg = event.data as ExtensionToWebview | undefined;
  if (!msg || msg.type !== EXTENSION_TO_WEBVIEW.ADD_SCRIPT_NAME_PICKED) return;
  const resolve = pending.get(msg.requestId);
  if (!resolve) return;
  pending.delete(msg.requestId);
  resolve(msg.name);
});

// Issue #212: the add-script dialog's name field moved off this webview's own ModalShell onto a
// native input box — it cannot call vscode.window.showInputBox itself, only the extension host
// can. Resolves to the entered name, or null on Escape/blur — the caller adds nothing either
// way, exactly like the deleted AddScriptDialog's onCancel. An empty/whitespace name never
// resolves here at all: the extension host's validateInput blocks accepting one.
export function pickScriptName(): Promise<string | null> {
  const requestId = `as-${++counter}`;
  return new Promise<string | null>(resolve => {
    pending.set(requestId, resolve);
    vscode.postMessage({ type: WEBVIEW_TO_EXTENSION.OPEN_ADD_SCRIPT_NAME, requestId });
  });
}

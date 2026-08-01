import { vscode } from './vscode';
import { EXTENSION_TO_WEBVIEW, WEBVIEW_TO_EXTENSION, type ExtensionToWebview } from './messages';

let counter = 0;
const pending = new Map<string, (formKey: string | null) => void>();

// Issue #210: single shared listener for every in-flight pickFormKey call below — the extension
// host's FORM_KEY_PICKED reply is correlated by requestId, never a broadcast (see messages.ts),
// so this resolves whichever call matches and leaves any other in-flight call untouched.
window.addEventListener('message', (event: MessageEvent<unknown>) => {
  const msg = event.data as ExtensionToWebview | undefined;
  if (!msg || msg.type !== EXTENSION_TO_WEBVIEW.FORM_KEY_PICKED) return;
  const resolve = pending.get(msg.requestId);
  if (!resolve) return;
  pending.delete(msg.requestId);
  resolve(msg.formKey);
});

// Issue #210: the FormKey picker moved off this webview — it cannot call
// vscode.window.createQuickPick itself, only the extension host can — onto a native QuickPick.
// Every FormKeyCell/VmadObjectEditor/AddPropertyDialog call site uses this in place of the
// deleted inline <FormKeyPicker>. `seed` is the current reference (empty string when there is
// none, e.g. adding a brand-new property) — the extension host seeds the QuickPick's value with
// it and pre-selects the matching item. Resolves to the picked FormKey, or null on Escape/blur —
// the caller leaves its field unchanged either way, exactly like the deleted picker's onClose.
export function pickFormKey(seed: string, validTypes: string[]): Promise<string | null> {
  const requestId = `fk-${++counter}`;
  return new Promise<string | null>(resolve => {
    pending.set(requestId, resolve);
    vscode.postMessage({ type: WEBVIEW_TO_EXTENSION.OPEN_FORM_KEY_PICKER, requestId, seed, validTypes });
  });
}

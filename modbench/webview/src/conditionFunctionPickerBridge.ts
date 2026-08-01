import { vscode } from './vscode';
import { EXTENSION_TO_WEBVIEW, WEBVIEW_TO_EXTENSION, type ExtensionToWebview } from './messages';

let counter = 0;
const pending = new Map<string, (functionName: string | null) => void>();

// Issue #211: single shared listener for every in-flight pickConditionFunction call below — same
// shape as formKeyPickerBridge.ts's listener (#210). The extension host's
// CONDITION_FUNCTION_PICKED reply is correlated by requestId, never a broadcast, so this resolves
// whichever call matches and leaves any other in-flight call untouched.
window.addEventListener('message', (event: MessageEvent<unknown>) => {
  const msg = event.data as ExtensionToWebview | undefined;
  if (!msg || msg.type !== EXTENSION_TO_WEBVIEW.CONDITION_FUNCTION_PICKED) return;
  const resolve = pending.get(msg.requestId);
  if (!resolve) return;
  pending.delete(msg.requestId);
  resolve(msg.functionName);
});

// Issue #211: the condition-function picker moved off this webview the same way #210 moved the
// FormKey picker — it cannot call vscode.window.showQuickPick itself, only the extension host
// can. `seed` is the condition's current function (empty string when there is none) — the
// extension host sorts it to the front of the QuickPick's item array. Resolves to the picked
// function name, or null on Escape/blur — the caller leaves the field unchanged either way,
// exactly like the deleted ConditionFunctionPicker's behavior on close-without-select.
export function pickConditionFunction(seed: string): Promise<string | null> {
  const requestId = `cf-${++counter}`;
  return new Promise<string | null>(resolve => {
    pending.set(requestId, resolve);
    vscode.postMessage({ type: WEBVIEW_TO_EXTENSION.OPEN_CONDITION_FUNCTION_PICKER, requestId, seed });
  });
}

import { vscode } from './vscode';
import { EXTENSION_TO_WEBVIEW, WEBVIEW_TO_EXTENSION, type ExtensionToWebview } from './messages';

let counter = 0;
const pending = new Map<string, (confirmed: boolean) => void>();

// Issue #212: single shared listener for every in-flight confirmRevertGroup call below — same
// shape as formKeyPickerBridge.ts's listener (#210). The extension host's
// REVERT_GROUP_CONFIRMED reply is correlated by requestId, never a broadcast, so this resolves
// whichever call matches and leaves any other in-flight call untouched.
window.addEventListener('message', (event: MessageEvent<unknown>) => {
  const msg = event.data as ExtensionToWebview | undefined;
  if (!msg || msg.type !== EXTENSION_TO_WEBVIEW.REVERT_GROUP_CONFIRMED) return;
  const resolve = pending.get(msg.requestId);
  if (!resolve) return;
  pending.delete(msg.requestId);
  resolve(msg.confirmed);
});

// Issue #212: the revert-group confirmation moved off this webview's own ModalShell onto a
// native modal warning (`vscode.window.showWarningMessage(..., { modal: true })`) — it cannot
// call that itself, only the extension host can. `detail` is the already-composed
// "recordType / formKey · fieldPath" listing of every linked edit that travels with the revert.
// Resolves true when the user confirms (clicked Revert), false otherwise — a Cancel and a
// dismiss (Escape/outside click) are indistinguishable at the native API and both mean "revert
// nothing", exactly like the deleted RevertGroupConfirm's onCancel.
export function confirmRevertGroup(detail: string): Promise<boolean> {
  const requestId = `rg-${++counter}`;
  return new Promise<boolean>(resolve => {
    pending.set(requestId, resolve);
    vscode.postMessage({ type: WEBVIEW_TO_EXTENSION.OPEN_REVERT_GROUP_CONFIRM, requestId, detail });
  });
}

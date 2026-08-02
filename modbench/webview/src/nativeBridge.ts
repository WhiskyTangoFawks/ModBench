import { vscode } from './vscode';
import { EXTENSION_TO_WEBVIEW, WEBVIEW_TO_EXTENSION, type ExtensionToWebview, type WebviewToExtension } from './messages';

// Issue #212: every native-prompt bridge below (#210's FormKey QuickPick, #211's
// condition-function QuickPick, #212's revert-group modal warning and add-script input box)
// shares one shape — post a request carrying a fresh requestId, await the extension host's
// reply correlated by that same requestId, resolve whichever in-flight call matches and leave
// every other one untouched. Four near-identical files each running their own counter/Map/
// listener triple was fine at two instances (#211 left it alone: "two concrete instances is thin
// ground for an abstraction"); at four it's a repeated shape worth naming once. `read` absorbs
// the one genuine difference between bridges — each reply's payload lives under a different
// field (formKey/functionName/confirmed/name) — so this file, and the single listener below, stay
// blind to what any particular bridge is actually asking for.
interface Pending {
  replyType: ExtensionToWebview['type'];
  read: (msg: ExtensionToWebview) => unknown;
  resolve: (value: unknown) => void;
}

let counter = 0;
const pending = new Map<string, Pending>();

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  const msg = event.data as ExtensionToWebview | undefined;
  if (!msg || !('requestId' in msg)) return;
  const entry = pending.get(msg.requestId);
  if (!entry || msg.type !== entry.replyType) return;
  pending.delete(msg.requestId);
  entry.resolve(entry.read(msg));
});

function requestReply<T>(
  replyType: ExtensionToWebview['type'],
  read: (msg: ExtensionToWebview) => T,
  buildRequest: (requestId: string) => WebviewToExtension,
): Promise<T> {
  const requestId = `nb-${++counter}`;
  return new Promise<T>(resolve => {
    pending.set(requestId, { replyType, read, resolve: resolve as (value: unknown) => void });
    vscode.postMessage(buildRequest(requestId));
  });
}

// Issue #210: the FormKey picker moved off this webview — it cannot call
// vscode.window.createQuickPick itself, only the extension host can — onto a native QuickPick.
// Every FormKeyCell/VmadObjectEditor/AddPropertyDialog call site uses this in place of the
// deleted inline <FormKeyPicker>. `seed` is the current reference (empty string when there is
// none, e.g. adding a brand-new property) — the extension host seeds the QuickPick's value with
// it and pre-selects the matching item. Resolves to the picked FormKey, or null on Escape/blur —
// the caller leaves its field unchanged either way, exactly like the deleted picker's onClose.
export function pickFormKey(seed: string, validTypes: string[]): Promise<string | null> {
  return requestReply(
    EXTENSION_TO_WEBVIEW.FORM_KEY_PICKED,
    msg => (msg.type === EXTENSION_TO_WEBVIEW.FORM_KEY_PICKED ? msg.formKey : null),
    requestId => ({ type: WEBVIEW_TO_EXTENSION.OPEN_FORM_KEY_PICKER, requestId, seed, validTypes }),
  );
}

// Issue #211: the condition-function picker moved off this webview the same way #210 moved the
// FormKey picker — it cannot call vscode.window.showQuickPick itself, only the extension host
// can. `seed` is the condition's current function (empty string when there is none) — the
// extension host sorts it to the front of the QuickPick's item array. Resolves to the picked
// function name, or null on Escape/blur — the caller leaves the field unchanged either way,
// exactly like the deleted ConditionFunctionPicker's behavior on close-without-select.
export function pickConditionFunction(seed: string): Promise<string | null> {
  return requestReply(
    EXTENSION_TO_WEBVIEW.CONDITION_FUNCTION_PICKED,
    msg => (msg.type === EXTENSION_TO_WEBVIEW.CONDITION_FUNCTION_PICKED ? msg.functionName : null),
    requestId => ({ type: WEBVIEW_TO_EXTENSION.OPEN_CONDITION_FUNCTION_PICKER, requestId, seed }),
  );
}

// Issue #212: the revert-group confirmation moved off this webview's own ModalShell onto a
// native modal warning (`vscode.window.showWarningMessage(..., { modal: true })`) — it cannot
// call that itself, only the extension host can. `detail` is the already-composed
// "recordType / formKey · fieldPath" listing of every linked edit that travels with the revert.
// Resolves true when the user confirms (clicked Revert), false otherwise — a Cancel and a
// dismiss (Escape/outside click) are indistinguishable at the native API and both mean "revert
// nothing", exactly like the deleted RevertGroupConfirm's onCancel.
export function confirmRevertGroup(detail: string): Promise<boolean> {
  return requestReply(
    EXTENSION_TO_WEBVIEW.REVERT_GROUP_CONFIRMED,
    msg => msg.type === EXTENSION_TO_WEBVIEW.REVERT_GROUP_CONFIRMED && msg.confirmed,
    requestId => ({ type: WEBVIEW_TO_EXTENSION.OPEN_REVERT_GROUP_CONFIRM, requestId, detail }),
  );
}

// Issue #212: the add-script dialog's name field moved off this webview's own ModalShell onto a
// native input box — it cannot call vscode.window.showInputBox itself, only the extension host
// can. Resolves to the entered name, or null on Escape/blur — the caller adds nothing either
// way, exactly like the deleted AddScriptDialog's onCancel. An empty/whitespace name never
// resolves here at all: the extension host's validateInput blocks accepting one.
export function pickScriptName(): Promise<string | null> {
  return requestReply(
    EXTENSION_TO_WEBVIEW.ADD_SCRIPT_NAME_PICKED,
    msg => (msg.type === EXTENSION_TO_WEBVIEW.ADD_SCRIPT_NAME_PICKED ? msg.name : null),
    requestId => ({ type: WEBVIEW_TO_EXTENSION.OPEN_ADD_SCRIPT_NAME, requestId }),
  );
}

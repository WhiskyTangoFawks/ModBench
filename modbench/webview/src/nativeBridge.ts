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

// Issue #230: the extended editor's commit callback doesn't fit `Pending` above — a real editor
// tab can be saved more than once while it stays open, so EXTENDED_EDITOR_COMMITTED is not a
// one-shot reply that resolves-then-deletes; the callback stays registered until
// EXTENDED_EDITOR_CLOSED explicitly says the tab is gone. A second map (rather than stretching
// `Pending`'s single-resolve shape to cover both lifecycles) keeps requestReply's own contract —
// "resolves exactly once" — true for every caller that already depends on it.
const extendedEditors = new Map<string, (value: string) => void>();

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  const msg = event.data as ExtensionToWebview | undefined;
  if (!msg || !('requestId' in msg)) return;
  if (msg.type === EXTENSION_TO_WEBVIEW.EXTENDED_EDITOR_COMMITTED) {
    extendedEditors.get(msg.requestId)?.(msg.value);
    return;
  }
  if (msg.type === EXTENSION_TO_WEBVIEW.EXTENDED_EDITOR_CLOSED) {
    // Issue #230 (seam): deleted here, not left to accumulate — a session that opens many
    // fields' extended editors over time would otherwise grow one stale map entry per tab ever
    // opened, each one holding a closure over that tab's onCommit and everything it captured.
    extendedEditors.delete(msg.requestId);
    return;
  }
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

// Issue #224: Ctrl+C's clipboard write — `vscode.env.clipboard.writeText` is extension-host-only
// (webview clipboard access isn't guaranteed), so DiskCell/DiffRow post the already-computed
// model value (modelValue.ts) up here instead. Unlike every bridge above, this is fire-and-forget
// rather than requestReply: nothing needs to come back, since the caller already has the string
// it copied — there's no answer to wait for, only a write to hand off.
export function copyToClipboard(value: string): void {
  vscode.postMessage({ type: WEBVIEW_TO_EXTENSION.COPY_TO_CLIPBOARD, value });
}

// Issue #225: Ctrl+V's clipboard read — the counterpart to copyToClipboard above, but unlike that
// fire-and-forget write, DiffRow's paste handler needs the text back to coerce (coerceModelValue)
// and commit itself, so this follows the requestReply shape every *Picker/*Confirm/*Name bridge
// above uses instead. Resolves null both when the clipboard held nothing worth pasting and when
// the host-side read itself failed (reported there, per ADR-0026) — the caller treats both the
// same way it treats any other uncoercible paste: leave the field unchanged.
export function readClipboardText(): Promise<string | null> {
  return requestReply(
    EXTENSION_TO_WEBVIEW.CLIPBOARD_READ,
    msg => (msg.type === EXTENSION_TO_WEBVIEW.CLIPBOARD_READ ? msg.value : null),
    requestId => ({ type: WEBVIEW_TO_EXTENSION.READ_CLIPBOARD, requestId }),
  );
}

// Issue #230: a `string` cell's double click opens the value in a real editor tab — the
// extension host can't be reached any other way (only it can call
// vscode.workspace.openTextDocument/showTextDocument). Unlike every bridge above, this doesn't
// return a Promise: there's no single answer to await, since the tab can be saved any number of
// times (each save re-stages, exactly like any other edit) before the user closes it, or never
// saved at all if they abandon it. `onCommit` is called once per save with that save's full
// content — DiffRow passes the same `onCommit` closure it already builds for the cell's inline
// editor, so this is a second *trigger* onto the identical commit path, not a second path.
export function openExtendedFieldEditor(
  params: {
    value: string; recordLabel: string; fieldName: string; plugin: string;
    // #272 / ADR-0036: required alongside `plugin` — see messages.ts' OPEN_EXTENDED_EDITOR doc
    // comment for why this isn't yet used for path derivation.
    origin: string;
    readOnly: boolean;
    // Issue #242: FocusedCell's own disk/pending discriminant (#232) — absent (disk cell) is
    // every pre-#242 call site's own meaning, unchanged; the pending column's own call site is
    // the one place that passes 'pending'.
    column?: 'pending';
  },
  onCommit: (value: string) => void,
): void {
  const requestId = `nb-${++counter}`;
  extendedEditors.set(requestId, onCommit);
  vscode.postMessage({ type: WEBVIEW_TO_EXTENSION.OPEN_EXTENDED_EDITOR, requestId, ...params });
}

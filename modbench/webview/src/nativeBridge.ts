import { vscode } from './vscode';
import { EXTENSION_TO_WEBVIEW, WEBVIEW_TO_EXTENSION, type ExtensionToWebview, type WebviewToExtension } from './messages';

// The webview's bridge to native VS Code surfaces. New native-surface gestures extend the shared
// request/reply mechanism below rather than reinventing it — see the doc comment on
// `requestReply` and `InFlight`.

// Every native-prompt bridge using this shape shares one
// contract — post a request carrying a fresh requestId, await the extension host's reply
// correlated by that same requestId, resolve whichever in-flight call matches and leave every
// other one untouched. `read` absorbs the one genuine difference between bridges — each reply's
// payload lives under a different field (formKey/functionName/confirmed/name) — so this file, and
// the single listener below, stay blind to what any particular bridge is actually asking for.
interface InFlight {
  replyType: ExtensionToWebview['type'];
  read: (msg: ExtensionToWebview) => unknown;
  resolve: (value: unknown) => void;
}

let counter = 0;
const inFlight = new Map<string, InFlight>();

// The extended editor's commit callback doesn't fit `InFlight` above — a real editor
// tab can be saved more than once while it stays open, so EXTENDED_EDITOR_COMMITTED is not a
// one-shot reply that resolves-then-deletes; the callback stays registered until
// EXTENDED_EDITOR_CLOSED explicitly says the tab is gone. A second map (rather than stretching
// `InFlight`'s single-resolve shape to cover both lifecycles) keeps requestReply's own contract —
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
    // Deleted here, not left to accumulate — a load order that opens many
    // fields' extended editors over time would otherwise grow one stale map entry per tab ever
    // opened, each one holding a closure over that tab's onCommit and everything it captured.
    extendedEditors.delete(msg.requestId);
    return;
  }
  const entry = inFlight.get(msg.requestId);
  if (!entry || msg.type !== entry.replyType) return;
  inFlight.delete(msg.requestId);
  entry.resolve(entry.read(msg));
});

function requestReply<T>(
  replyType: ExtensionToWebview['type'],
  read: (msg: ExtensionToWebview) => T,
  buildRequest: (requestId: string) => WebviewToExtension,
): Promise<T> {
  const requestId = `nb-${++counter}`;
  return new Promise<T>(resolve => {
    inFlight.set(requestId, { replyType, read, resolve: resolve as (value: unknown) => void });
    vscode.postMessage(buildRequest(requestId));
  });
}

// The FormKey picker is a native QuickPick — the webview cannot call
// vscode.window.createQuickPick itself, only the extension host can.
// Every FormKeyCell call site uses this in place of a rendered picker. `seed` is the current
// reference (empty string when there is none, e.g. adding a brand-new property) — the extension
// host seeds the QuickPick's value with it and pre-selects the matching item. Resolves to the
// picked FormKey, or null on Escape/blur — the caller leaves its field unchanged either way.
export function pickFormKey(seed: string, validTypes: string[]): Promise<string | null> {
  return requestReply(
    EXTENSION_TO_WEBVIEW.FORM_KEY_PICKED,
    msg => (msg.type === EXTENSION_TO_WEBVIEW.FORM_KEY_PICKED ? msg.formKey : null),
    requestId => ({ type: WEBVIEW_TO_EXTENSION.OPEN_FORM_KEY_PICKER, requestId, seed, validTypes }),
  );
}

// The condition-function picker as a native QuickPick — same
// "webview can't call the native API itself" reasoning as pickFormKey above, but simpler: the
// function catalogue is bounded and game-scoped, so the extension host fetches it once and hands
// it to a plain `showQuickPick` rather than driving `createQuickPick`'s per-keystroke search.
// `seed` is the condition's current function (empty string when there is none). Resolves to the
// picked function name, or null when dismissed without a selection — the caller leaves the
// condition unchanged either way, same convention as pickFormKey.
export function pickConditionFunction(seed: string): Promise<string | null> {
  return requestReply(
    EXTENSION_TO_WEBVIEW.CONDITION_FUNCTION_PICKED,
    msg => (msg.type === EXTENSION_TO_WEBVIEW.CONDITION_FUNCTION_PICKED ? msg.functionName : null),
    requestId => ({ type: WEBVIEW_TO_EXTENSION.OPEN_CONDITION_FUNCTION_PICKER, requestId, seed }),
  );
}

// Ctrl+C's clipboard write — `vscode.env.clipboard.writeText` is extension-host-only
// (webview clipboard access isn't guaranteed), so DiskCell/DiffRow post the already-computed
// model value (modelValue.ts) up here instead. Fire-and-forget: nothing needs to come back, since
// the caller already has the string it copied — there's no answer to wait for, only a write.
export function copyToClipboard(value: string): void {
  vscode.postMessage({ type: WEBVIEW_TO_EXTENSION.COPY_TO_CLIPBOARD, value });
}

// ADR-0041: one field edit, on its way to the single write path. Fire-and-forget in the same
// sense COPY_TO_CLIPBOARD is — the panel does not await a value back, because the answer to "what
// does the record say now" is a re-read (RECORD_EDITED), never this call's return. A refusal
// surfaces as a native notification from the host, which is why this goes through the bridge at all
// rather than posting to the backend from here the way every read does.
export function editField(
  formKey: string, plugin: string, origin: string, fieldPath: string, value: unknown,
): void {
  vscode.postMessage({ type: WEBVIEW_TO_EXTENSION.EDIT_FIELD, formKey, plugin, origin, fieldPath, value });
}

// A `string` cell's double click opens the value in a real editor
// tab — the extension host can't be reached any other way (only it can call
// vscode.workspace.openTextDocument/showTextDocument). Unlike every bridge above, this doesn't
// return a Promise: there's no single answer to await, since the tab can be saved any number of
// times (each save commits, exactly like any other edit) before the user closes it, or never
// saved at all if they abandon it. `onCommit` is called once per save with that save's full
// content — DiffRow passes the same `onCommit` closure it already builds for the cell's inline
// editor, so this is a second *trigger* onto the identical commit path, not a second path.
export function openExtendedFieldEditor(
  params: {
    value: string; recordLabel: string; fieldName: string; plugin: string;
    // ADR-0036: required alongside `plugin` — folded into the temp-file path
    // (extendedEditorPath's own directory segment) so two same-filename columns never alias onto
    // one file. See messages.ts' OPEN_EXTENDED_EDITOR doc comment.
    origin: string;
    readOnly: boolean;
  },
  onCommit: (value: string) => void,
): void {
  const requestId = `nb-${++counter}`;
  extendedEditors.set(requestId, onCommit);
  vscode.postMessage({ type: WEBVIEW_TO_EXTENSION.OPEN_EXTENDED_EDITOR, requestId, ...params });
}

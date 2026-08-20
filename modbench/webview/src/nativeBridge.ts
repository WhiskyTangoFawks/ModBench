import { vscode } from './vscode';
import { EXTENSION_TO_WEBVIEW, WEBVIEW_TO_EXTENSION, type ExtensionToWebview, type WebviewToExtension } from './messages';

// #410/ADR-0041 retired the request/reply bridge this module used to run — the FormKey QuickPick,
// the condition-function QuickPick, the revert-group modal, the add-script input box, the
// clipboard read, and the extended field editor — because every one of them fed the pending-change
// write path that went with it. #415 added back exactly one poster (editField, fire-and-forget,
// below) for the one gesture it restored. #426 restores the shared request/reply mechanism itself,
// for the first native-surface gesture that needs it back: the FormKey picker. Later gesture-
// inventory slices (the condition-function picker, etc.) extend this same mechanism rather than
// reinventing it — see the doc comment on `requestReply` and `Pending`.

// Issue #212: every native-prompt bridge that used this shape (the FormKey QuickPick, the
// condition-function QuickPick, the revert-group modal, the add-script input box) shares one
// contract — post a request carrying a fresh requestId, await the extension host's reply
// correlated by that same requestId, resolve whichever in-flight call matches and leave every
// other one untouched. `read` absorbs the one genuine difference between bridges — each reply's
// payload lives under a different field (formKey/functionName/confirmed/name) — so this file, and
// the single listener below, stay blind to what any particular bridge is actually asking for.
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

// Issue #210 (#426: restored): the FormKey picker moved off this webview — it cannot call
// vscode.window.createQuickPick itself, only the extension host can — onto a native QuickPick.
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

// Issue #224: Ctrl+C's clipboard write — `vscode.env.clipboard.writeText` is extension-host-only
// (webview clipboard access isn't guaranteed), so DiskCell/DiffRow post the already-computed
// model value (modelValue.ts) up here instead. Fire-and-forget: nothing needs to come back, since
// the caller already has the string it copied — there's no answer to wait for, only a write.
export function copyToClipboard(value: string): void {
  vscode.postMessage({ type: WEBVIEW_TO_EXTENSION.COPY_TO_CLIPBOARD, value });
}

// #415/ADR-0041: one field edit, on its way to the single write path. Fire-and-forget in the same
// sense COPY_TO_CLIPBOARD is — the panel does not await a value back, because the answer to "what
// does the record say now" is a re-read (RECORD_EDITED), never this call's return. A refusal
// surfaces as a native notification from the host, which is why this goes through the bridge at all
// rather than posting to the backend from here the way every read does.
export function editField(
  formKey: string, plugin: string, origin: string, fieldPath: string, value: unknown,
): void {
  vscode.postMessage({ type: WEBVIEW_TO_EXTENSION.EDIT_FIELD, formKey, plugin, origin, fieldPath, value });
}

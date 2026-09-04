import { vscode } from './vscode';
import { EXTENSION_TO_WEBVIEW, WEBVIEW_TO_EXTENSION, type ExtensionToWebview, type WebviewToExtension } from './messages';

// The webview's bridge to native VS Code surfaces: a new native-surface gesture extends the
// request/reply mechanism below rather than reinventing it.

// `read` absorbs the only real difference between bridges — each reply's payload lives under a
// different field — so the listener below stays blind to what is being asked.
interface InFlight {
  replyType: ExtensionToWebview['type'];
  read: (msg: ExtensionToWebview) => unknown;
  resolve: (value: unknown) => void;
}

let counter = 0;
const inFlight = new Map<string, InFlight>();

// An editor tab can be saved many times while open, so its commit callback is not the one-shot
// reply `InFlight` models; it stays registered until EXTENDED_EDITOR_CLOSED. A second map keeps
// requestReply's resolve-once contract true.
const extendedEditors = new Map<string, (value: string) => void>();

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  const msg = event.data as ExtensionToWebview | undefined;
  if (!msg || !('requestId' in msg)) return;
  if (msg.type === EXTENSION_TO_WEBVIEW.EXTENDED_EDITOR_COMMITTED) {
    extendedEditors.get(msg.requestId)?.(msg.value);
    return;
  }
  if (msg.type === EXTENSION_TO_WEBVIEW.EXTENDED_EDITOR_CLOSED) {
    // Deleted here, not left to accumulate: a stale entry holds a closure over that tab's
    // onCommit and everything it captured.
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

// The FormKey picker is a native QuickPick — only the extension host can call
// vscode.window.createQuickPick. Resolves to the picked FormKey, or null on Escape/blur, leaving
// the field unchanged.
export function pickFormKey(seed: string, validTypes: string[]): Promise<string | null> {
  return requestReply(
    EXTENSION_TO_WEBVIEW.FORM_KEY_PICKED,
    msg => (msg.type === EXTENSION_TO_WEBVIEW.FORM_KEY_PICKED ? msg.formKey : null),
    requestId => ({ type: WEBVIEW_TO_EXTENSION.OPEN_FORM_KEY_PICKER, requestId, seed, validTypes }),
  );
}

// `vscode.env.clipboard.writeText` is extension-host-only (webview clipboard access isn't
// guaranteed), so the caller posts the already-computed model value up here. Fire-and-forget:
// there is no answer to wait for.
export function copyToClipboard(value: string): void {
  vscode.postMessage({ type: WEBVIEW_TO_EXTENSION.COPY_TO_CLIPBOARD, value });
}

// ADR-0041: fire-and-forget — the answer to "what does the record say now" is a re-read, never
// this call's return. Refusals surface as a native notification, so this crosses the bridge, not
// the backend.
export function editField(
  formKey: string, plugin: string, origin: string, fieldPath: string, value: unknown,
): void {
  vscode.postMessage({ type: WEBVIEW_TO_EXTENSION.EDIT_FIELD, formKey, plugin, origin, fieldPath, value });
}

// Only the extension host can open a real editor tab. No Promise: the tab can be saved any number
// of times before closing, or never. `onCommit` runs once per save, on the same commit path as
// the inline editor.
export function openExtendedFieldEditor(
  params: {
    value: string; recordLabel: string; fieldName: string; plugin: string;
    // ADR-0036: required alongside `plugin` — folded into the temp-file path so two
    // same-filename columns never alias onto one file.
    origin: string;
    readOnly: boolean;
  },
  onCommit: (value: string) => void,
): void {
  const requestId = `nb-${++counter}`;
  extendedEditors.set(requestId, onCommit);
  vscode.postMessage({ type: WEBVIEW_TO_EXTENSION.OPEN_EXTENDED_EDITOR, requestId, ...params });
}

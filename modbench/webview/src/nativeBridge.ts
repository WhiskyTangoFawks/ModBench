import { vscode } from './vscode';
import {
  EXTENSION_TO_WEBVIEW, WEBVIEW_TO_EXTENSION,
  type ExtensionToWebview, type RecordEditEnvelope, type WebviewToExtension,
} from './messages';

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

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  const msg = event.data as ExtensionToWebview | undefined;
  if (!msg || !('requestId' in msg)) return;
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

// ADR-0007: fire-and-forget — the answer to "what does the record say now" is a re-read, never
// this call's return. Refusals surface as a native notification, so this crosses the bridge, not
// the backend.
export function editField(formKey: string, plugin: string, origin: string, envelope: RecordEditEnvelope): void {
  vscode.postMessage({ type: WEBVIEW_TO_EXTENSION.EDIT_FIELD, formKey, plugin, origin, envelope });
}

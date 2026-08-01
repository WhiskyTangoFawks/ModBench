export const EXTENSION_TO_WEBVIEW = {
  LOAD_RECORD: 'loadRecord',
} as const;

export const WEBVIEW_TO_EXTENSION = {
  OPEN_RECORD: 'openRecord',
  OPEN_RECORD_BESIDE: 'openRecordBeside',
  REVEAL_PENDING_CHANGE: 'revealPendingChange',
  // #174: posted after every successful pending-change mutation (stage/copy/remove/save/revert)
  // so the extension host's Pending Changes tree — a separate process from this webview,
  // bridged only by postMessage — refreshes instead of going stale.
  PENDING_CHANGED: 'pendingChanged',
  // #200: the webview has no route to the 'Modbench' output channel (#198) of its own — it's a
  // separate process, bridged only by postMessage. The webview composes the full message text
  // (it has the plugin/field/record identity); the router on the other end just forwards it to
  // the matching leveled call.
  LOG: 'log',
} as const;

export type LogLevel = 'debug' | 'info' | 'warn';

export type WebviewToExtension =
  | { type: typeof WEBVIEW_TO_EXTENSION.OPEN_RECORD; formKey: string }
  | { type: typeof WEBVIEW_TO_EXTENSION.OPEN_RECORD_BESIDE; formKey: string }
  | { type: typeof WEBVIEW_TO_EXTENSION.REVEAL_PENDING_CHANGE; changeId: string }
  | { type: typeof WEBVIEW_TO_EXTENSION.PENDING_CHANGED }
  | { type: typeof WEBVIEW_TO_EXTENSION.LOG; level: LogLevel; message: string };

export type ExtensionToWebview =
  | { type: typeof EXTENSION_TO_WEBVIEW.LOAD_RECORD; formKey: string };

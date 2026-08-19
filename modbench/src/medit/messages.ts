export const EXTENSION_TO_WEBVIEW = {
  LOAD_RECORD: 'loadRecord',
  // #308 / ADR-0035: the session's winner sweep has landed — every open record panel re-reads,
  // so a panel opened mid-load stops rendering a settled-looking grid over unsettled data.
  // Session-wide, never record-specific: no self-filter, every panel reacts.
  SESSION_CONFLICTS_COMPUTED: 'sessionConflictsComputed',
} as const;

export const WEBVIEW_TO_EXTENSION = {
  OPEN_RECORD: 'openRecord',
  // Issue #200: the webview has no route to the 'Modbench' channel (#198) of its own — this is
  // the bridge. The webview composes the full message text; the host does a level→method forward.
  LOG: 'log',
  // Issue #224: Ctrl+C's clipboard write — `vscode.env.clipboard.writeText` is extension-host-only
  // (webview clipboard access isn't guaranteed), so the webview posts the already-computed model
  // value up. Fire-and-forget: nothing comes back.
  COPY_TO_CLIPBOARD: 'copyToClipboard',
} as const;

export type LogLevel = 'debug' | 'info' | 'warn';

// #410/ADR-0041: the record editor is a viewer, so this bridge carries reads only. Everything it
// used to carry — the pending-cell and column-header command broadcasts, the array and VMAD
// structural-op broadcasts, the FormKey/condition-function/script-name pickers, the revert-group
// confirm, the clipboard read, and the extended field editor — existed to stage an edit through a
// backend endpoint that no longer exists (#410 S1). #415 rebuilds the edit surface on text.
export type WebviewToExtension =
  | { type: typeof WEBVIEW_TO_EXTENSION.OPEN_RECORD; formKey: string }
  | { type: typeof WEBVIEW_TO_EXTENSION.LOG; level: LogLevel; message: string }
  | { type: typeof WEBVIEW_TO_EXTENSION.COPY_TO_CLIPBOARD; value: string };

export type ExtensionToWebview =
  | { type: typeof EXTENSION_TO_WEBVIEW.LOAD_RECORD; formKey: string }
  | { type: typeof EXTENSION_TO_WEBVIEW.SESSION_CONFLICTS_COMPUTED };

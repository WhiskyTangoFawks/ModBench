export const EXTENSION_TO_WEBVIEW = {
  LOAD_RECORD: 'loadRecord',
  // #308 / ADR-0035: the session's winner sweep has landed — every open record panel re-reads,
  // so a panel opened mid-load stops rendering a settled-looking grid over unsettled data.
  // Session-wide, never record-specific: no self-filter, every panel reacts.
  SESSION_CONFLICTS_COMPUTED: 'sessionConflictsComputed',
  // #415: an edit landed as a working-tree change, so the panel re-reads. The backend is the only
  // thing that knows what the record now says, so the webview never patches its own grid from the
  // value it sent: the write path re-serializes through the codec, and the record's conflict
  // picture across every other column can move with it.
  RECORD_EDITED: 'recordEdited',
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
  // #415/ADR-0041: one field edit, on its way to the single write path. Routed through the
  // extension host rather than posted to the backend from the webview (which is how every *read*
  // travels) for one reason: an edit can be refused, and a refusal has to become a native
  // notification naming the way out — a surface only the host has (ADR-0026: the frontend decides
  // surfacing). The value is already in the wire shape the field's schema expects; nothing here
  // interprets it.
  EDIT_FIELD: 'editField',
} as const;

export type LogLevel = 'debug' | 'info' | 'warn';

// #410/ADR-0041: this bridge carried reads only while the record editor was a viewer. Most of what
// #410 removed stays removed — the pending-cell and column-header command broadcasts, the array and
// VMAD structural-op broadcasts, the FormKey/condition-function/script-name pickers, the
// revert-group confirm, the clipboard read, the extended field editor — because those were the
// *pending-change* surface, not editing as such. #415 rebuilds editing on text, and EDIT_FIELD is
// the whole of it: one field, one value, one working-tree change.
export type WebviewToExtension =
  | { type: typeof WEBVIEW_TO_EXTENSION.OPEN_RECORD; formKey: string }
  | { type: typeof WEBVIEW_TO_EXTENSION.LOG; level: LogLevel; message: string }
  | { type: typeof WEBVIEW_TO_EXTENSION.COPY_TO_CLIPBOARD; value: string }
  | {
      type: typeof WEBVIEW_TO_EXTENSION.EDIT_FIELD;
      formKey: string;
      // ADR-0036: the compound plugin identity, never a bare filename — the panel has both, and a
      // filename alone is ambiguous the moment two mods ship a plugin of the same name.
      plugin: string;
      origin: string;
      fieldPath: string;
      value: unknown;
    };

export type ExtensionToWebview =
  | { type: typeof EXTENSION_TO_WEBVIEW.LOAD_RECORD; formKey: string }
  | { type: typeof EXTENSION_TO_WEBVIEW.SESSION_CONFLICTS_COMPUTED }
  | { type: typeof EXTENSION_TO_WEBVIEW.RECORD_EDITED; formKey: string };

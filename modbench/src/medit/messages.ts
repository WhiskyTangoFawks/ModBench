export const EXTENSION_TO_WEBVIEW = {
  LOAD_RECORD: 'loadRecord',
  // ADR-0035: the winner sweep has landed, so a panel opened mid-reconcile stops rendering a
  // settled-looking grid over unsettled data. Load-order-wide: no self-filter, every panel reacts.
  CONFLICTS_COMPUTED: 'conflictsComputed',
  // The webview never patches its own grid from the value it sent: the write path re-serializes
  // through the codec, and the record's conflict picture across other columns can move with it.
  RECORD_EDITED: 'recordEdited',
  // A reply to the one panel that asked (`requestId`), never a broadcast: the QuickPick existed
  // only for that request. `formKey: null` is a dismissal, leaving the field unchanged.
  FORM_KEY_PICKED: 'formKeyPicked',
  // Not a one-shot reply: a tab can be saved repeatedly while open, so the webview keeps its
  // callback registered until EXTENDED_EDITOR_CLOSED.
  EXTENDED_EDITOR_COMMITTED: 'extendedEditorCommitted',
  // Lets nativeBridge delete its `requestId -> onCommit` entry, so a load order that opens many
  // extended editors accumulates no stale entry per tab. Carries no value: closing commits nothing.
  EXTENDED_EDITOR_CLOSED: 'extendedEditorClosed',
  // `path` addresses the array itself for 'add', the element for the other three; a top-level
  // array's path is one hop or empty, a nested array's carries every hop. The backend computes
  // the result, never the webview.
  ARRAY_STRUCTURAL_OP: 'arrayStructuralOp',
  // ADR-0039: right-click is the one route into the extended editor. Broadcast and self-filtered
  // like the array ops, carrying what the webview captured at right-click time, since only it
  // knows the record's display label.
  FIELD_OPEN_EXTENDED_EDITOR: 'fieldOpenExtendedEditor',
} as const;

export const WEBVIEW_TO_EXTENSION = {
  OPEN_RECORD: 'openRecord',
  // The webview has no route to the 'Modbench' channel of its own — this is
  // the bridge. The webview composes the full message text; the host does a level→method forward.
  LOG: 'log',
  // Ctrl+C's clipboard write — `vscode.env.clipboard.writeText` is extension-host-only
  // (webview clipboard access isn't guaranteed), so the webview posts the already-computed model
  // value up. Fire-and-forget: nothing comes back.
  COPY_TO_CLIPBOARD: 'copyToClipboard',
  // ADR-0041: routed through the extension host rather than posted to the backend the way a
  // *read* is, because an edit can be refused and a refusal has to become a native notification
  // (ADR-0026).
  EDIT_FIELD: 'editField',
  // Native QuickPick: only the extension host can call `vscode.window.createQuickPick`. `seed` is
  // the current reference (empty when there is none), which pre-selects the matching item.
  OPEN_FORM_KEY_PICKER: 'openFormKeyPicker',
  // The one type/gesture combination where double-click's target differs from second-click/F2's.
  // `readOnly` is decided webview-side, which already knows the column's editability; the host
  // turns identity into a filesystem-safe path, never the webview.
  OPEN_EXTENDED_EDITOR: 'openExtendedEditor',
} as const;

export type LogLevel = 'debug' | 'info' | 'warn';

export type WebviewToExtension =
  | { type: typeof WEBVIEW_TO_EXTENSION.OPEN_RECORD; formKey: string }
  | { type: typeof WEBVIEW_TO_EXTENSION.LOG; level: LogLevel; message: string }
  | { type: typeof WEBVIEW_TO_EXTENSION.COPY_TO_CLIPBOARD; value: string }
  | {
      type: typeof WEBVIEW_TO_EXTENSION.EDIT_FIELD;
      formKey: string;
      // ADR-0036: the compound plugin identity, never a bare filename — a filename alone is
      // ambiguous the moment the instance holds two copies of one name.
      plugin: string;
      origin: string;
      fieldPath: string;
      value: unknown;
    }
  | { type: typeof WEBVIEW_TO_EXTENSION.OPEN_FORM_KEY_PICKER; requestId: string; seed: string; validTypes: string[] }
  | {
      type: typeof WEBVIEW_TO_EXTENSION.OPEN_EXTENDED_EDITOR; requestId: string; value: string;
      recordLabel: string; fieldName: string; plugin: string;
      // ADR-0036: required alongside `plugin`, consistent with every other column-identity
      // payload above — folds into the temp-file path (extendedEditorPath's own directory
      // segment) so two same-filename columns never alias onto one file.
      origin: string;
      readOnly: boolean;
    };

// A `data-vscode-context` payload VS Code hands to the invoked command; it never travels through
// `postMessage`, hence beside the message unions rather than inside them. `path` carries every
// hop, which a bare index could not.
export interface ArrayElementContext {
  webviewSection: 'arrayElement';
  formKey: string;
  plugin: string;
  origin: string;
  rootField: string;
  path: PathSegment[];
  canMoveUp: boolean;
  canMoveDown: boolean;
  preventDefaultContextMenuItems: true;
}

// `path` addresses the array itself — `[]` for a top-level array, the row's own path within the
// subtree root for a nested one.
export interface ArrayParentContext {
  webviewSection: 'arrayParent';
  formKey: string;
  plugin: string;
  origin: string;
  rootField: string;
  path: PathSegment[];
  preventDefaultContextMenuItems: true;
}

// Resolving the commands this feeds never round-trips back through the webview: the mutation is
// an ordinary host-side call (ADR-0041), so this context only says which record, plugin and
// origin was right-clicked.
export interface ColumnHeaderContext {
  webviewSection: 'recordHeader';
  formKey: string;
  plugin: string;
  origin: string;
  preventDefaultContextMenuItems: true;
}

// A keyed element has no position a path could carry: one path serves every column of a row, and
// the same key sits elsewhere in each. `members` travels with it so the hop resolves with no
// schema in scope.
export type PathSegment =
  | { kind: 'member'; name: string }
  | { kind: 'index'; index: number }
  | { kind: 'sortKey'; key: string }
  | { kind: 'key'; key: string; members: string[] };

// ADR-0039: right-click is the extended editor's only trigger. `value`/`readOnly` come from the
// webview, not the host. Offered on immutable cells too: a read-only tab is the only way to read
// a long value in full.
export interface StringValueContext {
  webviewSection: 'stringValue';
  formKey: string;
  plugin: string;
  origin: string;
  fieldName: string;
  value: string;
  readOnly: boolean;
  // The row's path within the field plus the subtree root's wire path — enough for commit to
  // reconstruct the whole field exactly as an inline edit does, never committing the saved text
  // alone under the root's path.
  path: PathSegment[];
  rootField: string;
  preventDefaultContextMenuItems: true;
}

export type ExtensionToWebview =
  | { type: typeof EXTENSION_TO_WEBVIEW.LOAD_RECORD; formKey: string }
  | { type: typeof EXTENSION_TO_WEBVIEW.CONFLICTS_COMPUTED }
  | { type: typeof EXTENSION_TO_WEBVIEW.RECORD_EDITED; formKey: string }
  | { type: typeof EXTENSION_TO_WEBVIEW.FORM_KEY_PICKED; requestId: string; formKey: string | null }
  | { type: typeof EXTENSION_TO_WEBVIEW.EXTENDED_EDITOR_COMMITTED; requestId: string; value: string }
  | { type: typeof EXTENSION_TO_WEBVIEW.EXTENDED_EDITOR_CLOSED; requestId: string }
  // `rootField`/`path` are forwarded verbatim from the context; `op` names which gesture fired.
  | {
      type: typeof EXTENSION_TO_WEBVIEW.ARRAY_STRUCTURAL_OP; formKey: string; plugin: string; origin: string;
      rootField: string; path: PathSegment[]; op: 'add' | 'remove' | 'moveUp' | 'moveDown';
    }
  | {
      type: typeof EXTENSION_TO_WEBVIEW.FIELD_OPEN_EXTENDED_EDITOR; formKey: string; plugin: string; origin: string;
      fieldName: string; value: string; readOnly: boolean;
      // Forwarded verbatim from StringValueContext.
      path: PathSegment[]; rootField: string;
    };

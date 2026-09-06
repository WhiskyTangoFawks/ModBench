import type { components } from './generated/api';

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
      envelope: RecordEditEnvelope;
    }
  | { type: typeof WEBVIEW_TO_EXTENSION.OPEN_FORM_KEY_PICKER; requestId: string; seed: string; validTypes: string[] };

// A `data-vscode-context` payload VS Code hands the invoked command, never a `postMessage` — hence
// beside the message unions. `path` is the envelope's own wire path, resolved cell-side
// (`wirePath`): the host holds no document.
export interface ArrayElementContext {
  webviewSection: 'arrayElement';
  formKey: string;
  plugin: string;
  origin: string;
  path: PathHop[];
  canMoveUp: boolean;
  preventDefaultContextMenuItems: true;
}

// `path` addresses the array itself — one member hop for a top-level array, every hop down to the
// nested array for the rest.
export interface ArrayParentContext {
  webviewSection: 'arrayParent';
  formKey: string;
  plugin: string;
  origin: string;
  path: PathHop[];
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

// A row's hops under its subtree root, each as the diff node states it. A sorted array's element
// sits at a different position per column: addressed by its value here, an index hop once the
// envelope is built.
export type PathSegment =
  | { kind: 'member'; name: string }
  | { kind: 'index'; index: number }
  | { kind: 'key'; key: string }
  | { kind: 'value'; value: string };

/** The wire's hop kinds (ADR-0032), narrowed to the closed set the backend resolves. */
export type PathHop = Exclude<PathSegment, { kind: 'value' }>;

/** The one write shape: an operation, a path and an optional value, spelled by the webview and
 *  carried unchanged to `POST /records/{formKey}/edit`. */
export type RecordEditEnvelope =
  Omit<components['schemas']['RecordEditRequest'], 'plugin' | 'origin' | 'op' | 'path'>
  & { op: 'set' | 'add' | 'remove' | 'move'; path: PathHop[] };

/** A move's destination is the neighbour's position, so only an element addressed by index has
 *  one; the menu entry and the keyboard accelerator both build the move here. */
export function moveEnvelope(path: PathHop[], delta: -1 | 1): RecordEditEnvelope | undefined {
  const element = path.at(-1);
  return element?.kind === 'index' ? { op: 'move', path, value: element.index + delta } : undefined;
}

// ADR-0039: right-click is the extended editor's only trigger. `value`/`readOnly` come from the
// webview, not the host. Offered on immutable cells too: a read-only tab is the only way to read
// a long value in full.
export interface StringValueContext {
  webviewSection: 'stringValue';
  formKey: string;
  plugin: string;
  origin: string;
  // The record as every other identity-bearing surface here spells it ("EditorID [FormKey]"), for
  // the temp file's own directory — only the webview knows the record's display label.
  recordLabel: string;
  // The row's own label, which is what the tab is titled by — a nested leaf names itself, not the
  // member it sits under.
  fieldName: string;
  value: string;
  readOnly: boolean;
  // The wire path of the row the menu was opened on — the save commits the same set envelope at
  // the same path an inline edit of that row posts.
  path: PathHop[];
  preventDefaultContextMenuItems: true;
}

export type ExtensionToWebview =
  | { type: typeof EXTENSION_TO_WEBVIEW.LOAD_RECORD; formKey: string }
  | { type: typeof EXTENSION_TO_WEBVIEW.CONFLICTS_COMPUTED }
  | { type: typeof EXTENSION_TO_WEBVIEW.RECORD_EDITED; formKey: string }
  | { type: typeof EXTENSION_TO_WEBVIEW.FORM_KEY_PICKED; requestId: string; formKey: string | null };

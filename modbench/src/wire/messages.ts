import type { components } from './generated/api';

export const EXTENSION_TO_WEBVIEW = {
  LOAD_RECORD: 'loadRecord',
  // ADR-0013: the winner sweep has landed, so a panel opened mid-reconcile stops rendering a
  // settled-looking grid over unsettled data. Load-order-wide: no self-filter, every panel reacts.
  CONFLICTS_COMPUTED: 'conflictsComputed',
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
  // ADR-0007: routed through the extension host rather than posted to the backend the way a
  // *read* is, because an edit can be refused and a refusal has to become a native notification
  // (ADR-0019).
  EDIT_FIELD: 'editField',
  // Native QuickPick: only the extension host can call `vscode.window.createQuickPick`. `seed` is
  // the current reference (empty when there is none), which pre-selects the matching item.
  OPEN_FORM_KEY_PICKER: 'openFormKeyPicker',
  // commands.md, Record: a field gesture from the palette acts on the focused cell, which only the
  // panel knows. `context` is what its right-click hands a command; `null` is no focused cell.
  FOCUS_CELL: 'focusCell',
} as const;

export type LogLevel = 'debug' | 'info' | 'warn';

export type WebviewToExtension =
  | { type: typeof WEBVIEW_TO_EXTENSION.OPEN_RECORD; formKey: string }
  | { type: typeof WEBVIEW_TO_EXTENSION.LOG; level: LogLevel; message: string }
  | { type: typeof WEBVIEW_TO_EXTENSION.COPY_TO_CLIPBOARD; value: string }
  | {
      type: typeof WEBVIEW_TO_EXTENSION.EDIT_FIELD;
      formKey: string;
      // ADR-0012: the compound plugin identity, never a bare filename — a filename alone is
      // ambiguous the moment the instance holds two plugins that share a filename.
      plugin: string;
      origin: string;
      envelope: RecordEditEnvelope;
    }
  | { type: typeof WEBVIEW_TO_EXTENSION.OPEN_FORM_KEY_PICKER; requestId: string; seed: string; validTypes: string[] }
  | { type: typeof WEBVIEW_TO_EXTENSION.FOCUS_CELL; context: Record<string, unknown> | null };

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
  canMoveDown: boolean;
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
// an ordinary host-side call (ADR-0007), so this context only says which record, plugin and
// origin was right-clicked.
export interface ColumnHeaderContext {
  webviewSection: 'recordHeader';
  formKey: string;
  plugin: string;
  origin: string;
  // commands.md, compile: the column's plugin is tracked and editable.
  compilable: boolean;
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

/** The wire's hop kinds (ADR-0005), narrowed to the closed set the backend resolves. */
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

// ADR-0018: right-click is the extended editor's only trigger. `value`/`readOnly` come from the
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
  | { type: typeof EXTENSION_TO_WEBVIEW.FORM_KEY_PICKED; requestId: string; formKey: string | null };

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isLogLevel(value: unknown): value is LogLevel {
  return value === 'debug' || value === 'info' || value === 'warn';
}

function isRecordEditEnvelope(value: unknown): value is RecordEditEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const witness = value as { op?: unknown; path?: unknown };
  return (
    (witness.op === 'set' || witness.op === 'add' || witness.op === 'remove' || witness.op === 'move')
    && Array.isArray(witness.path)
  );
}

type WebviewToExtensionWitness = {
  type?: unknown; formKey?: unknown; level?: unknown; message?: unknown; value?: unknown;
  plugin?: unknown; origin?: unknown; envelope?: unknown;
  requestId?: unknown; seed?: unknown; validTypes?: unknown; context?: unknown;
};

function parseOpenRecord(w: WebviewToExtensionWitness): WebviewToExtension {
  if (!isString(w.formKey)) throw new Error('Expected "openRecord" to carry a string formKey.');
  return { type: WEBVIEW_TO_EXTENSION.OPEN_RECORD, formKey: w.formKey };
}

function parseLog(w: WebviewToExtensionWitness): WebviewToExtension {
  if (!isLogLevel(w.level)) throw new Error('Expected "log" to carry a level of debug, info or warn.');
  if (!isString(w.message)) throw new Error('Expected "log" to carry a string message.');
  return { type: WEBVIEW_TO_EXTENSION.LOG, level: w.level, message: w.message };
}

function parseCopyToClipboard(w: WebviewToExtensionWitness): WebviewToExtension {
  if (!isString(w.value)) throw new Error('Expected "copyToClipboard" to carry a string value.');
  return { type: WEBVIEW_TO_EXTENSION.COPY_TO_CLIPBOARD, value: w.value };
}

function parseEditField(w: WebviewToExtensionWitness): WebviewToExtension {
  if (!isString(w.formKey)) throw new Error('Expected "editField" to carry a string formKey.');
  if (!isString(w.plugin)) throw new Error('Expected "editField" to carry a string plugin.');
  if (!isString(w.origin)) throw new Error('Expected "editField" to carry a string origin.');
  if (!isRecordEditEnvelope(w.envelope)) {
    throw new Error('Expected "editField" to carry a record edit envelope with an op and a path.');
  }
  return { type: WEBVIEW_TO_EXTENSION.EDIT_FIELD, formKey: w.formKey, plugin: w.plugin, origin: w.origin, envelope: w.envelope };
}

function parseOpenFormKeyPicker(w: WebviewToExtensionWitness): WebviewToExtension {
  if (!isString(w.requestId)) throw new Error('Expected "openFormKeyPicker" to carry a string requestId.');
  if (!isString(w.seed)) throw new Error('Expected "openFormKeyPicker" to carry a string seed.');
  if (!Array.isArray(w.validTypes) || !w.validTypes.every(isString)) {
    throw new Error('Expected "openFormKeyPicker" to carry a string array validTypes.');
  }
  return { type: WEBVIEW_TO_EXTENSION.OPEN_FORM_KEY_PICKER, requestId: w.requestId, seed: w.seed, validTypes: w.validTypes };
}

function isContextObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseFocusCell(w: WebviewToExtensionWitness): WebviewToExtension {
  if (w.context === null) return { type: WEBVIEW_TO_EXTENSION.FOCUS_CELL, context: null };
  if (!isContextObject(w.context)) throw new Error('Expected "focusCell" to carry a context object or null.');
  return { type: WEBVIEW_TO_EXTENSION.FOCUS_CELL, context: w.context };
}

/** The webview message router's one entry point for data crossing `postMessage`: every
 *  `WEBVIEW_TO_EXTENSION` site parses through this rather than asserting the shape itself.
 *  Throws when the discriminant or a required field doesn't match what the type demands. */
export function parseWebviewToExtension(value: unknown): WebviewToExtension {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`Expected a webview-to-extension message object, got ${typeof value}.`);
  }
  const w = value as WebviewToExtensionWitness;
  switch (w.type) {
    case WEBVIEW_TO_EXTENSION.OPEN_RECORD: return parseOpenRecord(w);
    case WEBVIEW_TO_EXTENSION.LOG: return parseLog(w);
    case WEBVIEW_TO_EXTENSION.COPY_TO_CLIPBOARD: return parseCopyToClipboard(w);
    case WEBVIEW_TO_EXTENSION.EDIT_FIELD: return parseEditField(w);
    case WEBVIEW_TO_EXTENSION.OPEN_FORM_KEY_PICKER: return parseOpenFormKeyPicker(w);
    case WEBVIEW_TO_EXTENSION.FOCUS_CELL: return parseFocusCell(w);
    default:
      throw new Error(`Unknown webview-to-extension message type: ${String(w.type)}.`);
  }
}

/** The webview message router's other direction: every `EXTENSION_TO_WEBVIEW` listener parses
 *  through this rather than asserting `event.data`'s shape itself. */
export function parseExtensionToWebview(value: unknown): ExtensionToWebview {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`Expected an extension-to-webview message object, got ${typeof value}.`);
  }
  const w = value as { type?: unknown; formKey?: unknown; requestId?: unknown };
  switch (w.type) {
    case EXTENSION_TO_WEBVIEW.LOAD_RECORD:
      if (!isString(w.formKey)) throw new Error('Expected "loadRecord" to carry a string formKey.');
      return { type: w.type, formKey: w.formKey };

    case EXTENSION_TO_WEBVIEW.CONFLICTS_COMPUTED:
      return { type: w.type };

    case EXTENSION_TO_WEBVIEW.FORM_KEY_PICKED:
      if (!isString(w.requestId)) throw new Error('Expected "formKeyPicked" to carry a string requestId.');
      if (w.formKey !== null && !isString(w.formKey)) {
        throw new Error('Expected "formKeyPicked" to carry a string or null formKey.');
      }
      return { type: w.type, requestId: w.requestId, formKey: w.formKey };

    default:
      throw new Error(`Unknown extension-to-webview message type: ${String(w.type)}.`);
  }
}

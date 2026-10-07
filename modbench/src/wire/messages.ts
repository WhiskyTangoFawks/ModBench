import type { components } from './generated/api';
import type { PluginAddress } from './pluginAddress';
import type { ColumnKey } from './columnKey';

export const EXTENSION_TO_WEBVIEW = {
  LOAD_RECORD: 'loadRecord',
  // A reply to the one panel that asked (`requestId`), never a broadcast: the QuickPick existed
  // only for that request. `formKey: null` is a dismissal, leaving the field unchanged.
  FORM_KEY_PICKED: 'formKeyPicked',
  // The host's answer to REQUEST_RECORD_LOAD: the comparison, the plugin list and whether the
  // winner sweep has run, posted untransformed, so the webview names no port.
  RECORD_LOAD_ANSWERED: 'recordLoadAnswered',
  // The grid's keys are VS Code keybindings; these reach the focused cell of the panel in focus,
  // which alone holds its editor and its field's schema to parse pasted text with.
  OPEN_CELL_EDITOR: 'openCellEditor',
  PASTE_INTO_CELL: 'pasteIntoCell',
  // The records the tab shows beside its document's own from now on, read at once.
  SHOW_COLUMNS: 'showColumns',
} as const;

export const WEBVIEW_TO_EXTENSION = {
  // Routed through the extension host because a refused edit becomes a native notification
  // (editor.md, Reporting, story 1).
  EDIT_FIELD: 'editField',
  // A drop on an array, an entry point to the add its right-click menu fires, with the dropped value.
  ADD_ELEMENT: 'addElement',
  // Native QuickPick: only the extension host can call `vscode.window.createQuickPick`. `seed` is
  // the current reference (empty when there is none), which pre-selects the matching item.
  OPEN_FORM_KEY_PICKER: 'openFormKeyPicker',
  // commands.md, Record: a field gesture from the palette acts on the focused cell, which only the
  // panel knows. `context` is what its right-click hands a command; `null` is no focused cell.
  FOCUS_CELL: 'focusCell',
  // RecordPanelClient's own read, asked of the host's mEdit client rather than fetched by the
  // webview itself. `requestId` pairs the reply.
  REQUEST_RECORD_LOAD: 'requestRecordLoad',
  // A click on a column's header (editor.md, Columns, story 8): the records the tab opens on in its
  // own place, the first as the file.
  OPEN_IN_PLACE: 'openInPlace',
  // The grid's place, which the tab an edit's move of its file opens shows again (editor.md, States,
  // story 5).
  VIEW_STATE: 'viewState',
} as const;

export type ConflictThis = components['schemas']['ConflictThis'];
export type ConflictAll = components['schemas']['ConflictAll'];


export type WebviewToExtension =
  | {
      type: typeof WEBVIEW_TO_EXTENSION.EDIT_FIELD;
      formKey: string;
      // ADR-0012.
      plugin: string;
      origin: string;
      envelope: RecordEditEnvelope;
    }
  | { type: typeof WEBVIEW_TO_EXTENSION.ADD_ELEMENT; context: Record<string, unknown>; value?: unknown }
  | { type: typeof WEBVIEW_TO_EXTENSION.OPEN_FORM_KEY_PICKER; requestId: string; seed: string; validTypes: string[] }
  | { type: typeof WEBVIEW_TO_EXTENSION.FOCUS_CELL; context: Record<string, unknown> | null; entered: boolean }
  | { type: typeof WEBVIEW_TO_EXTENSION.REQUEST_RECORD_LOAD; requestId: string; formKey: string; columns: ColumnCopy[] }
  | { type: typeof WEBVIEW_TO_EXTENSION.OPEN_IN_PLACE; records: ColumnCopy[] }
  | { type: typeof WEBVIEW_TO_EXTENSION.VIEW_STATE; state: ViewState };

/** A record's copy the grid shows beside its document's own (editor.md, Columns, story 7). */
export type ColumnCopy = Omit<components['schemas']['RecordCopy'], 'documentText'>;

/** The rows collapsed, the columns collapsed, the focused cell and the scroll of a grid. */
export interface ViewState {
  collapsedRows: string[];
  collapsedColumns: ColumnKey[];
  focusedCell: { rowKey: string; plugin: ColumnKey | null } | null;
  scroll: { top: number; left: number };
}

const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every(isString);

function isFocusedCell(value: unknown): value is ViewState['focusedCell'] {
  return value === null || (typeof value === 'object' && 'rowKey' in value && isString(value.rowKey)
    && 'plugin' in value && (value.plugin === null || isString(value.plugin)));
}

function isScroll(value: unknown): value is ViewState['scroll'] {
  return typeof value === 'object' && value !== null
    && 'top' in value && typeof value.top === 'number' && 'left' in value && typeof value.left === 'number';
}

export function isViewState(value: unknown): value is ViewState {
  return typeof value === 'object' && value !== null
    && 'collapsedRows' in value && isStrings(value.collapsedRows)
    && 'collapsedColumns' in value && isStrings(value.collapsedColumns)
    && 'focusedCell' in value && isFocusedCell(value.focusedCell)
    && 'scroll' in value && isScroll(value.scroll);
}

function isPluginAddress(value: unknown): value is PluginAddress {
  return typeof value === 'object' && value !== null
    && 'name' in value && isString(value.name) && 'origin' in value && isString(value.origin);
}

export function isColumnCopies(value: unknown): value is ColumnCopy[] {
  return Array.isArray(value) && value.every((copy: unknown) =>
    typeof copy === 'object' && copy !== null && 'formKey' in copy && isString(copy.formKey)
    && 'plugin' in copy && isPluginAddress(copy.plugin));
}

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
// an ordinary host-side call, so this context only says which record, plugin and
// origin was right-clicked.
export interface ColumnHeaderContext {
  webviewSection: 'recordHeader';
  formKey: string;
  plugin: string;
  origin: string;
  // commands.md, compile: the column's plugin is tracked and not read-only. It stays offered when
  // the plugin source is unreadable, and refuses.
  compilable: boolean;
  // commands.md, delete: compilable, and the plugin source reads.
  editable: boolean;
  // editor.md, Menus and keys: track is offered on a plugin in an untracked mod, decompile on one in
  // a tracked mod. None is the game's plugin, Overwrite's, and one whose tracked state is unknown.
  inMod: 'tracked' | 'untracked' | 'none';
  preventDefaultContextMenuItems: true;
}

// A row's hops under its subtree root. An array's element has its own index in each column that
// holds it, as its diff node states, and an element of a keyed array takes no move.
export type PathSegment =
  | { kind: 'member'; name: string }
  | { kind: 'index'; index: number }
  | { kind: 'element'; indexes: components['schemas']['FieldDiff']['indexes']; keyed: boolean };

/** The wire's hop kinds (ADR-0005), narrowed to the closed set the backend resolves. */
export type PathHop = Exclude<PathSegment, { kind: 'element' }>;

/** The one write shape: an operation, a path and an optional value, spelled by the webview and
 *  carried unchanged to `POST /records/{formKey}/edit-changes`. */
export type RecordEditEnvelope =
  Omit<components['schemas']['RecordEditRequest'], 'plugin' | 'origin' | 'op' | 'path'>
  & { op: 'set' | 'add' | 'remove' | 'move'; path: PathHop[] };

/** A move's destination is the neighbour's position; the menu entry and the keyboard accelerator
 *  both build the move here. */
export function moveEnvelope(path: PathHop[], delta: -1 | 1): RecordEditEnvelope | undefined {
  const element = path.at(-1);
  return element?.kind === 'index' ? { op: 'move', path, value: element.index + delta } : undefined;
}

// A cell in a column that can be edited, which Delete clears and Ctrl+V pastes over. `holdsValue`
// is whether the column's plugin holds the field, since clearing what it does not hold changes nothing.
export interface EditableCellContext {
  webviewSection: 'editableCell';
  formKey: string;
  plugin: string;
  origin: string;
  path: PathHop[];
  holdsValue: boolean;
}

/** Whether a `data-vscode-context` names `section` among its space-separated sections, as a menu's
 *  `=~` reads them. */
export function hasSection(context: unknown, section: string): boolean {
  if (typeof context !== 'object' || context === null) return false;
  const sections: unknown = Reflect.get(context, 'webviewSection');
  return typeof sections === 'string' && sections.split(' ').includes(section);
}

// A reference that resolves, or resolves to the wrong type, which go to record follows. The target
// is its own key because `formKey` already names the record the panel shows.
export interface ReferenceContext {
  webviewSection: 'reference';
  referenceTarget: string;
}

// The extended editor's only trigger (xedit.md, divergence 6). `value`/`readOnly` come from the
// webview, not the host. Offered on immutable cells too: a read-only tab is the only way to read
// a long value in full.
export interface StringValueContext {
  webviewSection: 'stringValue';
  formKey: string;
  plugin: string;
  origin: string;
  // The record as every other identity-bearing surface here spells it ("EditorID [FormKey]"), for
  // the tab's path — only the webview knows the record's display label.
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

/** RecordPanelClient's own read, carried untransformed — the webview still derives its own column
 *  sets from `plugins` (ADR-0005). `plugins` is null exactly when that one read
 *  failed, degrading only that slice. */
export type RecordLoadAnswer =
  | {
      ok: true;
      // Null is a record held by no active plugin.
      compare: components['schemas']['CompareResult'] | null;
      plugins: components['schemas']['PluginResponse'][] | null;
      conflictsComputed: boolean;
      // The plugins mEdit cannot read, as the Plugins tree is told them.
      loadFailures: components['schemas']['PluginLoadFailure'][];
      documentPlugin: PluginAddress;
    }
  | { ok: false; error: string };

export type ExtensionToWebview =
  | { type: typeof EXTENSION_TO_WEBVIEW.LOAD_RECORD; formKey: string }
  | { type: typeof EXTENSION_TO_WEBVIEW.FORM_KEY_PICKED; requestId: string; formKey: string | null }
  | ({ type: typeof EXTENSION_TO_WEBVIEW.RECORD_LOAD_ANSWERED; requestId: string } & RecordLoadAnswer)
  | { type: typeof EXTENSION_TO_WEBVIEW.OPEN_CELL_EDITOR }
  | { type: typeof EXTENSION_TO_WEBVIEW.PASTE_INTO_CELL; text: string }
  | { type: typeof EXTENSION_TO_WEBVIEW.SHOW_COLUMNS; columns: ColumnCopy[] };

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

export function isRecordEditEnvelope(value: unknown): value is RecordEditEnvelope {
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
  requestId?: unknown; seed?: unknown; validTypes?: unknown; context?: unknown; entered?: unknown; columns?: unknown;
  records?: unknown; state?: unknown;
};

function parseEditField(w: WebviewToExtensionWitness): WebviewToExtension {
  if (!isString(w.formKey)) throw new Error('Expected "editField" to carry a string formKey.');
  if (!isString(w.plugin)) throw new Error('Expected "editField" to carry a string plugin.');
  if (!isString(w.origin)) throw new Error('Expected "editField" to carry a string origin.');
  if (!isRecordEditEnvelope(w.envelope)) {
    throw new Error('Expected "editField" to carry a record edit envelope with an op and a path.');
  }
  return { type: WEBVIEW_TO_EXTENSION.EDIT_FIELD, formKey: w.formKey, plugin: w.plugin, origin: w.origin, envelope: w.envelope };
}

function parseAddElement(w: WebviewToExtensionWitness): WebviewToExtension {
  if (!isContextObject(w.context)) throw new Error('Expected "addElement" to carry a context object.');
  return { type: WEBVIEW_TO_EXTENSION.ADD_ELEMENT, context: w.context, value: w.value };
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
  if (typeof w.entered !== 'boolean') throw new Error('Expected "focusCell" to carry a boolean entered.');
  if (w.context === null) return { type: WEBVIEW_TO_EXTENSION.FOCUS_CELL, context: null, entered: w.entered };
  if (!isContextObject(w.context)) throw new Error('Expected "focusCell" to carry a context object or null.');
  return { type: WEBVIEW_TO_EXTENSION.FOCUS_CELL, context: w.context, entered: w.entered };
}

function parseRequestRecordLoad(w: WebviewToExtensionWitness): WebviewToExtension {
  if (!isString(w.requestId)) throw new Error('Expected "requestRecordLoad" to carry a string requestId.');
  if (!isString(w.formKey)) throw new Error('Expected "requestRecordLoad" to carry a string formKey.');
  if (!isColumnCopies(w.columns)) throw new Error('Expected "requestRecordLoad" to carry its columns, each a FormKey and a plugin.');
  return { type: WEBVIEW_TO_EXTENSION.REQUEST_RECORD_LOAD, requestId: w.requestId, formKey: w.formKey, columns: w.columns };
}

function parseOpenInPlace(w: WebviewToExtensionWitness): WebviewToExtension {
  if (!isColumnCopies(w.records)) throw new Error('Expected "openInPlace" to carry its records, each a FormKey and a plugin.');
  return { type: WEBVIEW_TO_EXTENSION.OPEN_IN_PLACE, records: w.records };
}

function parseViewState(w: WebviewToExtensionWitness): WebviewToExtension {
  if (!isViewState(w.state)) throw new Error('Expected "viewState" to carry the grid\'s collapsed rows and columns, focused cell and scroll.');
  return { type: WEBVIEW_TO_EXTENSION.VIEW_STATE, state: w.state };
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
    case WEBVIEW_TO_EXTENSION.EDIT_FIELD: return parseEditField(w);
    case WEBVIEW_TO_EXTENSION.ADD_ELEMENT: return parseAddElement(w);
    case WEBVIEW_TO_EXTENSION.OPEN_FORM_KEY_PICKER: return parseOpenFormKeyPicker(w);
    case WEBVIEW_TO_EXTENSION.FOCUS_CELL: return parseFocusCell(w);
    case WEBVIEW_TO_EXTENSION.REQUEST_RECORD_LOAD: return parseRequestRecordLoad(w);
    case WEBVIEW_TO_EXTENSION.OPEN_IN_PLACE: return parseOpenInPlace(w);
    case WEBVIEW_TO_EXTENSION.VIEW_STATE: return parseViewState(w);
    default:
      throw new Error(`Unknown webview-to-extension message type: ${String(w.type)}.`);
  }
}

// Shallow: compare/plugins are the schema's own nested shapes, trusted once the envelope checks
// out. A type predicate narrows unknown without an `as` cast.
function isCompareResultShape(value: unknown): value is components['schemas']['CompareResult'] {
  return typeof value === 'object' && value !== null;
}

function isPluginResponseArray(value: unknown): value is components['schemas']['PluginResponse'][] {
  return Array.isArray(value);
}

function isPluginLoadFailureArray(value: unknown): value is components['schemas']['PluginLoadFailure'][] {
  return Array.isArray(value);
}

function parseLoadRecord(w: { formKey?: unknown }): ExtensionToWebview {
  if (!isString(w.formKey)) throw new Error('Expected "loadRecord" to carry a string formKey.');
  return { type: EXTENSION_TO_WEBVIEW.LOAD_RECORD, formKey: w.formKey };
}

function parseFormKeyPicked(w: { requestId?: unknown; formKey?: unknown }): ExtensionToWebview {
  if (!isString(w.requestId)) throw new Error('Expected "formKeyPicked" to carry a string requestId.');
  if (w.formKey !== null && !isString(w.formKey)) {
    throw new Error('Expected "formKeyPicked" to carry a string or null formKey.');
  }
  return { type: EXTENSION_TO_WEBVIEW.FORM_KEY_PICKED, requestId: w.requestId, formKey: w.formKey };
}

function parseRecordLoadAnswer(w: {
  requestId?: unknown; ok?: unknown; compare?: unknown; plugins?: unknown; conflictsComputed?: unknown; loadFailures?: unknown; error?: unknown;
  documentPlugin?: unknown;
}): { requestId: string } & RecordLoadAnswer {
  if (!isString(w.requestId)) throw new Error('Expected "recordLoadAnswered" to carry a string requestId.');
  if (w.ok === false) {
    if (!isString(w.error)) throw new Error('Expected a refused "recordLoadAnswered" to carry a string error.');
    return { requestId: w.requestId, ok: false, error: w.error };
  }
  if (w.ok !== true) throw new Error('Expected "recordLoadAnswered" to carry a boolean ok.');
  return { requestId: w.requestId, ...parseAnswered(w) };
}

function parseAnswered(w: {
  compare?: unknown; plugins?: unknown; conflictsComputed?: unknown; loadFailures?: unknown; documentPlugin?: unknown;
}): RecordLoadAnswer {
  if (w.compare !== null && !isCompareResultShape(w.compare)) {
    throw new Error('Expected an answered "recordLoadAnswered" to carry a compare object or null.');
  }
  if (w.plugins !== null && !isPluginResponseArray(w.plugins)) {
    throw new Error('Expected "recordLoadAnswered" to carry a plugins array or null.');
  }
  if (typeof w.conflictsComputed !== 'boolean') {
    throw new Error('Expected "recordLoadAnswered" to carry a boolean conflictsComputed.');
  }
  if (!isPluginLoadFailureArray(w.loadFailures)) {
    throw new Error('Expected "recordLoadAnswered" to carry a loadFailures array.');
  }
  if (!isPluginAddress(w.documentPlugin)) throw new Error('Expected "recordLoadAnswered" to carry the document\'s plugin.');
  return {
    ok: true, compare: w.compare, plugins: w.plugins, conflictsComputed: w.conflictsComputed,
    loadFailures: w.loadFailures, documentPlugin: w.documentPlugin,
  };
}

/** The webview message router's other direction: every `EXTENSION_TO_WEBVIEW` listener parses
 *  through this rather than asserting `event.data`'s shape itself. */
export function parseExtensionToWebview(value: unknown): ExtensionToWebview {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`Expected an extension-to-webview message object, got ${typeof value}.`);
  }
  const w = value as {
    type?: unknown; formKey?: unknown; requestId?: unknown;
    ok?: unknown; compare?: unknown; plugins?: unknown; conflictsComputed?: unknown; loadFailures?: unknown; error?: unknown;
    documentPlugin?: unknown; text?: unknown; columns?: unknown;
  };
  switch (w.type) {
    case EXTENSION_TO_WEBVIEW.LOAD_RECORD: return parseLoadRecord(w);
    case EXTENSION_TO_WEBVIEW.SHOW_COLUMNS: return parseShowColumns(w);
    case EXTENSION_TO_WEBVIEW.FORM_KEY_PICKED: return parseFormKeyPicked(w);
    case EXTENSION_TO_WEBVIEW.RECORD_LOAD_ANSWERED: return { type: w.type, ...parseRecordLoadAnswer(w) };
    default: return parseFocusedCellMessage(w);
  }
}

function parseShowColumns(w: { columns?: unknown }): ExtensionToWebview {
  if (!isColumnCopies(w.columns)) throw new Error('Expected "showColumns" to carry its columns, each a FormKey and a plugin.');
  return { type: EXTENSION_TO_WEBVIEW.SHOW_COLUMNS, columns: w.columns };
}

function parseFocusedCellMessage(w: { type?: unknown; text?: unknown }): ExtensionToWebview {
  if (w.type === EXTENSION_TO_WEBVIEW.OPEN_CELL_EDITOR) return { type: w.type };
  if (w.type !== EXTENSION_TO_WEBVIEW.PASTE_INTO_CELL) {
    throw new Error(`Unknown extension-to-webview message type: ${String(w.type)}.`);
  }
  if (!isString(w.text)) throw new Error('Expected "pasteIntoCell" to carry a string text.');
  return { type: w.type, text: w.text };
}

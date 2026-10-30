import type { components } from './generated/api';
import type { PluginAddress } from './pluginAddress';
import type { ArgumentOf } from './argument';
import type { ColumnKey } from './columnKey';
import type { ReadFailed } from './readFailed';

export const EXTENSION_TO_WEBVIEW = {
  LOAD_RECORD: 'loadRecord',
  // A reply to the one panel that asked (`requestId`), never a broadcast: the QuickPick existed
  // only for that request. `formKey: null` is a dismissal, leaving the field unchanged.
  FORM_KEY_PICKED: 'formKeyPicked',
  // The reply to OPEN_ENUM_PICKER; `value: null` is a dismissal.
  ENUM_PICKED: 'enumPicked',
  // The host's answer to REQUEST_RECORD_LOAD: the comparison, the plugin list and whether the
  // winner sweep has run, posted untransformed, so the webview names no port.
  RECORD_LOAD_ANSWERED: 'recordLoadAnswered',
  // The grid's keys are VS Code keybindings; these reach the focused cell of the panel in focus,
  // which alone holds its editor and its field's schema to parse pasted text with.
  OPEN_CELL_EDITOR: 'openCellEditor',
  PASTE_INTO_CELL: 'pasteIntoCell',
  // The records the tab shows beside its document's own from now on, read at once.
  SHOW_COLUMNS: 'showColumns',
  // A mod's repository state changed in the instance: the origins the tab showed, read again.
  MODS_CHANGED: 'modsChanged',
  // The lens Collapse No Conflict is in, for every record panel (editor.md, Menus and keys).
  COLLAPSE_NO_CONFLICT: 'collapseNoConflict',
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
  // The same native pick for an enum: `choices` are the names to list, `current` the value the
  // pick opens on.
  OPEN_ENUM_PICKER: 'openEnumPicker',
  // commands.md, The entry point supplies what it knows: a field gesture from the palette acts on the
  // focused cell, which only the panel knows. `context` is what its right-click hands a command; `null` is no focused cell.
  FOCUS_CELL: 'focusCell',
  // RecordPanelClient's own read, asked of the host's mEdit client rather than fetched by the
  // webview itself. `requestId` pairs the reply.
  REQUEST_RECORD_LOAD: 'requestRecordLoad',
  // A click on a column's header (editor.md, Columns, story 8): the records the tab opens, the first as
  // the file.
  OPEN_COLUMNS: 'openColumns',
  // The grid's place, which the tab an edit's move of its file opens shows again (editor.md, States,
  // story 5).
  VIEW_STATE: 'viewState',
} as const;

/** Why a compiled plugin's source does not read, and whether decompile gets past it. */
export type UnreadableSource = components['schemas']['UnreadableSource'];
export type ConflictThis = components['schemas']['ConflictThis'];
export type ConflictAll = components['schemas']['ConflictAll'];
export type FieldMetadata = components['schemas']['FieldMetadata'];


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
  | { type: typeof WEBVIEW_TO_EXTENSION.OPEN_ENUM_PICKER; requestId: string; choices: EnumChoice[]; current: string }
  | { type: typeof WEBVIEW_TO_EXTENSION.FOCUS_CELL; context: FocusedCellContext | null; entered: boolean }
  | { type: typeof WEBVIEW_TO_EXTENSION.REQUEST_RECORD_LOAD; requestId: string; formKey: string; columns: RecordCopy[] }
  | { type: typeof WEBVIEW_TO_EXTENSION.OPEN_COLUMNS; records: RecordCopy[] }
  | { type: typeof WEBVIEW_TO_EXTENSION.VIEW_STATE; state: ViewState };

/** A plugin's copy of a record. */
export type RecordCopy = Omit<components['schemas']['RecordCopy'], 'documentText'>;

export interface ViewState {
  collapsedRows: string[];
  restoredRows: string[];
  restoredColumns: ColumnKey[];
  collapsedColumns: ColumnKey[];
  focusedCell: { rowKey: string; plugin: ColumnKey | null } | null;
  scroll: { top: number; left: number };
}


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
    && 'collapsedRows' in value && isStringArray(value.collapsedRows)
    && 'restoredRows' in value && isStringArray(value.restoredRows)
    && 'restoredColumns' in value && isStringArray(value.restoredColumns)
    && 'collapsedColumns' in value && isStringArray(value.collapsedColumns)
    && 'focusedCell' in value && isFocusedCell(value.focusedCell)
    && 'scroll' in value && isScroll(value.scroll);
}

export function isPluginAddress(value: unknown): value is PluginAddress {
  return typeof value === 'object' && value !== null
    && 'name' in value && isString(value.name) && 'origin' in value && isString(value.origin);
}

export function isColumnCopies(value: unknown): value is RecordCopy[] {
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
// an ordinary host-side call, so this context only says which record was right-clicked.
export interface ColumnHeaderContext {
  webviewSection: 'recordHeader';
  // commands.md, Argument: the column's record, as its plugin's address and its FormKey.
  argument: ArgumentOf<'record'>;
  // commands.md, delete: the column's plugin is a compiled plugin and not read-only, and the plugin source reads.
  editable: boolean;
  // editor.md, Menus and keys: which of decompile and commit, or decompile and build, a plugin's mod is offered.
  // None is a plugin in no mod: the game's and Overwrite's.
  inMod: ModRepository | 'none';
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

export type ModRepository = 'sourceMod' | 'nonSourceMod';

/** RecordPanelClient's own read, carried untransformed — the webview still derives its own column
 *  sets from `plugins` (ADR-0005). `plugins` is null exactly when that one read
 *  failed, degrading only that slice. */
export type RecordLoadAnswer =
  | ({
      ok: true;
      plugins: components['schemas']['PluginResponse'][] | null;
      conflictsComputed: boolean;
      // The plugins mEdit cannot read, as the Plugins tree is told them.
      loadFailures: components['schemas']['PluginLoadFailure'][];
      documentPlugin: PluginAddress;
      // The repository state of each origin in the comparison that names a mod, read from the
      // instance. An origin in no mod is absent.
      modsByOrigin: Record<string, ModRepository>;
      fileCopyAlone: boolean;
      // The origin of the mod whose file overrides the tab's plugin; null when none does.
      fileOverriddenBy: string | null;
    } & RecordRead)
  | { ok: false; failure: ReadFailed };

/** What the read gave: the comparison, or the records held by no plugin at all (editor.md, States, story 4)
 *  with mEdit's word on each copy only the plugin it names lacks (story 2). */
export type RecordRead =
  | { compare: components['schemas']['CompareResult'] }
  | { compare: null; gone: string[]; copiesLacking: string[] };

export type ExtensionToWebview =
  | { type: typeof EXTENSION_TO_WEBVIEW.LOAD_RECORD; formKey: string }
  | { type: typeof EXTENSION_TO_WEBVIEW.FORM_KEY_PICKED; requestId: string; formKey: string | null }
  | { type: typeof EXTENSION_TO_WEBVIEW.ENUM_PICKED; requestId: string; value: string | null }
  | ({ type: typeof EXTENSION_TO_WEBVIEW.RECORD_LOAD_ANSWERED; requestId: string } & RecordLoadAnswer)
  | { type: typeof EXTENSION_TO_WEBVIEW.OPEN_CELL_EDITOR }
  | { type: typeof EXTENSION_TO_WEBVIEW.PASTE_INTO_CELL; text: string }
  | { type: typeof EXTENSION_TO_WEBVIEW.SHOW_COLUMNS; columns: RecordCopy[] }
  | { type: typeof EXTENSION_TO_WEBVIEW.MODS_CHANGED; modsByOrigin: Record<string, ModRepository> }
  | { type: typeof EXTENSION_TO_WEBVIEW.COLLAPSE_NO_CONFLICT; lens: 'off' | 'on' | 'again' };

export function isString(value: unknown): value is string {
  return typeof value === 'string';
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

export function isRecordEditEnvelope(value: unknown): value is RecordEditEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const witness = value as { op?: unknown; path?: unknown };
  return (
    (witness.op === 'set' || witness.op === 'add' || witness.op === 'remove' || witness.op === 'move')
    && Array.isArray(witness.path)
  );
}

export interface EnumChoice { value: string; label: string }

function isContextObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A record tab's focused cell, as the context its right-click menu hands a command. The members
 *  named are the ones the host reads; the cell's own sections carry the rest. */
export interface FocusedCellContext {
  webviewSection?: string;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  copyText?: string;
  editorOpen?: boolean;
}

const focusedCellMembers = {
  webviewSection: isString,
  canMoveUp: (value: unknown) => typeof value === 'boolean',
  canMoveDown: (value: unknown) => typeof value === 'boolean',
  copyText: isString,
  editorOpen: (value: unknown) => typeof value === 'boolean',
};

export function isFocusedCellContext(value: unknown): value is FocusedCellContext {
  return isContextObject(value) && Object.entries(focusedCellMembers).every(([name, holds]) => value[name] === undefined || holds(value[name]));
}

function hasTypeIn(value: unknown, types: Record<string, string>): boolean {
  return typeof value === 'object' && value !== null && 'type' in value
    && Object.values(types).some((type) => type === value.type);
}

/** The webview message router's one entry point for data crossing `postMessage`. Both ends compile
 *  from the same types in the same .vsix, so the type is checked and the rest is the sender's. */
export function parseWebviewToExtension(value: unknown): WebviewToExtension {
  if (!hasTypeIn(value, WEBVIEW_TO_EXTENSION)) throw new Error('Expected a webview-to-extension message of a known type.');
  return value as WebviewToExtension;
}

/** The webview message router's other direction, checked the same way. */
export function parseExtensionToWebview(value: unknown): ExtensionToWebview {
  if (!hasTypeIn(value, EXTENSION_TO_WEBVIEW)) throw new Error('Expected an extension-to-webview message of a known type.');
  return value as ExtensionToWebview;
}

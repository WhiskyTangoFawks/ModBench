export const EXTENSION_TO_WEBVIEW = {
  LOAD_RECORD: 'loadRecord',
  // ADR-0035: the load order's winner sweep has landed — every open record panel re-reads,
  // so a panel opened mid-reconcile stops rendering a settled-looking grid over unsettled data.
  // Load-order-wide, never record-specific: no self-filter, every panel reacts.
  CONFLICTS_COMPUTED: 'conflictsComputed',
  // An edit landed as a working-tree change, so the panel re-reads. The backend is the only
  // thing that knows what the record now says, so the webview never patches its own grid from the
  // value it sent: the write path re-serializes through the codec, and the record's conflict
  // picture across every other column can move with it.
  RECORD_EDITED: 'recordEdited',
  // The FormKey picker's reply — a direct reply to the one panel that asked (via
  // `requestId`, matched by the webview-side pickFormKey bridge), never a broadcast: the
  // QuickPick that produced it only ever existed for that one request. `formKey: null` means the
  // user dismissed the picker (Escape/blur) — the caller leaves its field unchanged.
  FORM_KEY_PICKED: 'formKeyPicked',
  // Same shape as FORM_KEY_PICKED above (direct reply, keyed by requestId, never a
  // broadcast) — the condition-function QuickPick only ever exists for the one request that
  // opened it. `functionName: null` means the user dismissed it — the caller leaves the
  // condition's function unchanged.
  CONDITION_FUNCTION_PICKED: 'conditionFunctionPicked',
  // The extended editor's commit — unlike FORM_KEY_PICKED above (resolved once, then
  // done), a real editor tab can be saved more than once while it stays open, so this is not a
  // one-shot reply: the extension host posts one of these per `Ctrl+S` against the temp file it
  // opened for `requestId`, and the webview's nativeBridge keeps that `requestId`'s callback
  // registered (not deleted after the first message) until EXTENDED_EDITOR_CLOSED arrives.
  // `value` is the file's full saved content — the same string a normal commit would carry
  // through `onCommit`.
  EXTENDED_EDITOR_COMMITTED: 'extendedEditorCommitted',
  // Fired once, when the user closes the tab (`onDidCloseTextDocument`) — the signal
  // nativeBridge needs to delete its `requestId -> onCommit` map entry so a load order that opens
  // many fields' extended editors over time doesn't accumulate one stale entry per tab ever
  // opened. Carries no value: closing commits nothing beyond whatever EXTENDED_EDITOR_COMMITTED
  // messages already arrived before it.
  EXTENDED_EDITOR_CLOSED: 'extendedEditorClosed',
  // #630: the array-op right-click commands broadcast to every open record panel and let each
  // self-filter on `formKey` — the extension host has no live reference into the webview's own
  // React state — but unlike before, no webview-side computation happens for an ordinary reflected
  // field's array: `op`/`rootField`/`path` travel straight through to `handleEditCell`/EDIT_FIELD as
  // an op envelope (`{op, path}` under `rootField`), and `RecordFieldWriter`/`ArrayOpWriter` compute
  // the result server-side from the record's own current value and schema — the same shape
  // VMAD_STRUCTURAL_OP below already established for VMAD's own ops. Two deliberate exceptions: a
  // VMAD scalar-array property's own arity ops (VmadCodec's own structural-op vocabulary) and a
  // Condition-owning field's (Fallout4ConditionCodec.ApplyListValue requires a JSON array and
  // refuses an op-envelope object) are both out of #630's scope and still compute client-side —
  // RecordPanel's own handleArrayOp tells all three apart. `path` addresses the array
  // itself for 'add', the element for the other three; a top-level array's is a one-hop (or empty)
  // path, a nested array's carries every hop from `rootField`.
  ARRAY_STRUCTURAL_OP: 'arrayStructuralOp',
  // VMAD's six structural-op right-click commands
  // (Add/Remove Script, Add/Remove Property, Set Script/Property Flags) all reduce, on Track 0's
  // backend, to the exact same shape EDIT_FIELD already carries — a VmadPath fieldPath
  // (`VMAD\<Script>` or `VMAD\<Script>\<Property>`) and an op-envelope value
  // (`{op: "add_script", ...}`, RecordFieldWriter.ApplyVmadField's own contract). Rather than six
  // near-identical broadcast shapes, every command below resolves its own fieldPath/value and broadcasts this one
  // message; each open panel self-filters on `formKey` and commits through the identical
  // handleEditCell/EDIT_FIELD path every other gesture already uses — no new webview-side
  // computation at all, unlike the array-op broadcasts above.
  VMAD_STRUCTURAL_OP: 'vmadStructuralOp',
  // Add Property is the one structural op that collects more than a single native
  // prompt can hold (name, type, and a type-appropriate value) — a deliberate exception:
  // a webview-rendered dialog rather than a QuickPick chain. This broadcast only tells the
  // matching panel which script/plugin to open it for; the dialog's own confirm computes the
  // fieldPath/value itself and commits through the ordinary write path, the same as every other
  // gesture — no reply travels back through this message.
  VMAD_OPEN_ADD_PROPERTY: 'vmadOpenAddProperty',
  // ADR-0039: the string-cell right-click menu's own entry — same broadcast-and-self-filter
  // shape as the array/VMAD ops above, and for the identical reason: the extension host has no
  // live reference into the webview's own React state, which alone knows the record's own display
  // label (RecordPanel's handleOpenExtended builds it). This message carries everything the
  // stringValueContext (recordUtils.ts) already captured at right-click time — identity, current
  // value, readOnly — so the matching panel can call handleOpenExtended exactly as it always has
  // been able to (right-click is the one route in — ADR-0039); no new webview-side computation,
  // only a new trigger onto the same bridge call.
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
  // ADR-0041: one field edit, on its way to the single write path. Routed through the
  // extension host rather than posted to the backend from the webview (which is how every *read*
  // travels) for one reason: an edit can be refused, and a refusal has to become a native
  // notification naming the way out — a surface only the host has (ADR-0026: the frontend decides
  // surfacing). The value is already in the wire shape the field's schema expects; nothing here
  // interprets it.
  EDIT_FIELD: 'editField',
  // The FormKey picker is a native QuickPick on the extension host (the webview cannot call
  // vscode.window.createQuickPick itself — only the extension host can).
  // `seed` is the current reference (empty string when there is none), shown in the QuickPick's
  // value and used to pre-select the matching item; `validTypes` is the field's allowed record
  // types, same filter the picker always applied.
  OPEN_FORM_KEY_PICKER: 'openFormKeyPicker',
  // The condition-function picker is host-side the same way the FormKey
  // picker is — a native `showQuickPick` over the loaded game's function catalogue
  // (bounded, game-scoped, fetched once — no per-keystroke search, unlike OPEN_FORM_KEY_PICKER
  // above). `seed` is the condition's current function; the extension host sorts it to the front
  // of the QuickPick's item array (showQuickPick has no activeItem option the way createQuickPick
  // does, so array order is the only way to pre-highlight an item).
  OPEN_CONDITION_FUNCTION_PICKER: 'openConditionFunctionPicker',
  // A `string`-typed value cell's double click — the *only* type/gesture combination where
  // double-click's target differs from second-click/F2's (see ScalarCell's own doc comment). `value`
  // seeds the tab; `readOnly` is decided by the webview (it already knows the column's own
  // editability) rather than re-derived on the extension-host side. The extension host owns
  // turning `recordLabel`/`fieldName`/`plugin` into a filesystem-safe path — a host-only concern
  // (only it touches the filesystem), so the webview hands over identity, not a pre-built path.
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
      // ADR-0036: the compound plugin identity, never a bare filename — the panel has both, and a
      // filename alone is ambiguous the moment two mods ship a plugin of the same name.
      plugin: string;
      origin: string;
      fieldPath: string;
      value: unknown;
    }
  | { type: typeof WEBVIEW_TO_EXTENSION.OPEN_FORM_KEY_PICKER; requestId: string; seed: string; validTypes: string[] }
  | { type: typeof WEBVIEW_TO_EXTENSION.OPEN_CONDITION_FUNCTION_PICKER; requestId: string; seed: string }
  | {
      type: typeof WEBVIEW_TO_EXTENSION.OPEN_EXTENDED_EDITOR; requestId: string; value: string;
      recordLabel: string; fieldName: string; plugin: string;
      // ADR-0036: required alongside `plugin`, consistent with every other column-identity
      // payload above — folds into the temp-file path (extendedEditorPath's own directory
      // segment) so two same-filename columns never alias onto one file.
      origin: string;
      readOnly: boolean;
    };

// The shape of a `data-vscode-context` payload VS Code
// parses and hands to the invoked command — never travels through `postMessage` itself, so these
// live beside (not inside) WebviewToExtension/ExtensionToWebview, the commands only
// need them for typing `ctx`. `recordUtils.ts`'s `arrayElementContext`/`arrayParentContext` build
// these; `combineVscodeContexts` there turns one (or several) into the actual attribute string.
// `path`/`rootField`: see PathSegment's own doc comment below. A top-level array's element is a
// one-hop path; a nested array's carries every hop, which a bare scalar index could never.
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

// Same mechanism as ArrayElementContext/ArrayParentContext
// above, carried by VMAD's own row kinds instead — the "Scripts (VMAD)" wrapper row (Add Script),
// a script row (Remove Script, Add Property, Set Script Flags), or a property row (Remove
// Property, Set Property Flags). No extra identity beyond script/property name travels here: the
// structural op itself resolves the rest from the record's own current VMAD tree, server-side.
export interface VmadScriptsContext {
  webviewSection: 'vmadScripts';
  formKey: string;
  plugin: string;
  origin: string;
  preventDefaultContextMenuItems: true;
}

export interface VmadScriptContext {
  webviewSection: 'vmadScript';
  formKey: string;
  plugin: string;
  origin: string;
  scriptName: string;
  // Seeds Set Script Flags' own QuickPick — null when this column has no disk value for the row
  // (nothing to seed with).
  currentFlags: string | null;
  preventDefaultContextMenuItems: true;
}

export interface VmadPropertyContext {
  webviewSection: 'vmadProperty';
  formKey: string;
  plugin: string;
  origin: string;
  scriptName: string;
  propName: string;
  preventDefaultContextMenuItems: true;
}

// The record editor's own column header — one
// override column's identity, carried the same way every other native-menu context here is.
// Unlike the row-scoped contexts above, resolving the command this feeds (Copy as Override Into…/
// Copy as New Record Into…) never round-trips back through the webview at all: since ADR-0041 the
// mutation is an ordinary `LoadOrderController` HTTP call the extension host already owns, the same
// as the plugins-tree row entry point for the identical two commands — this context exists only
// to tell the host *which* record/plugin/origin was right-clicked.
export interface ColumnHeaderContext {
  webviewSection: 'recordHeader';
  formKey: string;
  plugin: string;
  origin: string;
  preventDefaultContextMenuItems: true;
}

// The chain from a row's own restage root
// (a plain reflected field, or a wirePath-bearing VMAD/Condition subtree) down to a given row's
// own value — a struct hop addressed by member name, an unsorted-array hop by position, a sorted
// (pure FormLink) array hop by the element's own value (nothing addresses *beneath* a sortKey
// hop). Lives here, not in a webview module, because StringValueContext/
// FIELD_OPEN_EXTENDED_EDITOR below need it, and this module is the one the extension host already imports
// directly (extension.ts) — importing a webview type into the host would run the dependency the
// wrong way. The webview re-exports this (webview/src/messages.ts, webview/src/types.ts) rather
// than the reverse.
export type PathSegment =
  | { kind: 'member'; name: string }
  | { kind: 'index'; index: number }
  | { kind: 'sortKey'; key: string };

// ADR-0039: a `string` value cell's own right-click identity — the extended editor's only
// trigger; no left-click gesture reaches it. `value`/`readOnly` travel here
// (computed at DiffRow's render time) rather than being re-derived host-side, since only the
// webview knows the cell's own current model value and editability. Offered on every string
// cell, mutable or immutable alike — a read-only tab is still the only way to read a long
// immutable value in full.
export interface StringValueContext {
  webviewSection: 'stringValue';
  formKey: string;
  plugin: string;
  origin: string;
  fieldName: string;
  value: string;
  readOnly: boolean;
  // The row's own path within the field (empty for a top-level field) and the subtree
  // root's own wire path — together enough for the panel's commit to reconstruct the whole field
  // exactly the way an inline edit already does (RecordPanel.tsx's handleCellCommit),
  // never committing the saved text alone under the root's own path.
  // `fieldName` above keeps its existing role (the extended-editor tab's own display path) —
  // `rootField` is what commit-resolution actually keys off.
  path: PathSegment[];
  rootField: string;
  preventDefaultContextMenuItems: true;
}

export type ExtensionToWebview =
  | { type: typeof EXTENSION_TO_WEBVIEW.LOAD_RECORD; formKey: string }
  | { type: typeof EXTENSION_TO_WEBVIEW.CONFLICTS_COMPUTED }
  | { type: typeof EXTENSION_TO_WEBVIEW.RECORD_EDITED; formKey: string }
  | { type: typeof EXTENSION_TO_WEBVIEW.FORM_KEY_PICKED; requestId: string; formKey: string | null }
  | { type: typeof EXTENSION_TO_WEBVIEW.CONDITION_FUNCTION_PICKED; requestId: string; functionName: string | null }
  | { type: typeof EXTENSION_TO_WEBVIEW.EXTENDED_EDITOR_COMMITTED; requestId: string; value: string }
  | { type: typeof EXTENSION_TO_WEBVIEW.EXTENDED_EDITOR_CLOSED; requestId: string }
  // `rootField`/`path` are forwarded verbatim from
  // ArrayElementContext/ArrayParentContext (see their own doc comments above); `op` names which of
  // the four gestures fired.
  | {
      type: typeof EXTENSION_TO_WEBVIEW.ARRAY_STRUCTURAL_OP; formKey: string; plugin: string; origin: string;
      rootField: string; path: PathSegment[]; op: 'add' | 'remove' | 'moveUp' | 'moveDown';
    }
  | { type: typeof EXTENSION_TO_WEBVIEW.VMAD_STRUCTURAL_OP; formKey: string; plugin: string; origin: string; fieldPath: string; value: unknown }
  | { type: typeof EXTENSION_TO_WEBVIEW.VMAD_OPEN_ADD_PROPERTY; formKey: string; plugin: string; origin: string; scriptName: string }
  | {
      type: typeof EXTENSION_TO_WEBVIEW.FIELD_OPEN_EXTENDED_EDITOR; formKey: string; plugin: string; origin: string;
      fieldName: string; value: string; readOnly: boolean;
      // Forwarded verbatim from StringValueContext — see its own doc comment above.
      path: PathSegment[]; rootField: string;
    };

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
  // #426: the FormKey picker's reply — a direct reply to the one panel that asked (via
  // `requestId`, matched by the webview-side pickFormKey bridge), never a broadcast: the
  // QuickPick that produced it only ever existed for that one request. `formKey: null` means the
  // user dismissed the picker (Escape/blur) — the caller leaves its field unchanged.
  FORM_KEY_PICKED: 'formKeyPicked',
  // #426 Track 5: same shape as FORM_KEY_PICKED above (direct reply, keyed by requestId, never a
  // broadcast) — the condition-function QuickPick only ever exists for the one request that
  // opened it. `functionName: null` means the user dismissed it — the caller leaves the
  // condition's function unchanged.
  CONDITION_FUNCTION_PICKED: 'conditionFunctionPicked',
  // #426: the extended editor's commit — unlike FORM_KEY_PICKED above (resolved once, then
  // done), a real editor tab can be saved more than once while it stays open, so this is not a
  // one-shot reply: the extension host posts one of these per `Ctrl+S` against the temp file it
  // opened for `requestId`, and the webview's nativeBridge keeps that `requestId`'s callback
  // registered (not deleted after the first message) until EXTENDED_EDITOR_CLOSED arrives.
  // `value` is the file's full saved content — the same string a normal commit would carry
  // through `onCommit`.
  EXTENDED_EDITOR_COMMITTED: 'extendedEditorCommitted',
  // #426: fired once, when the user closes the tab (`onDidCloseTextDocument`) — the signal
  // nativeBridge needs to delete its `requestId -> onCommit` map entry so a session that opens
  // many fields' extended editors over time doesn't accumulate one stale entry per tab ever
  // opened. Carries no value: closing commits nothing beyond whatever EXTENDED_EDITOR_COMMITTED
  // messages already arrived before it.
  EXTENDED_EDITOR_CLOSED: 'extendedEditorClosed',
  // Issue #142/#227 (#426 Track 4: restored): the array-op right-click commands broadcast to every
  // open record panel and let each self-filter on `formKey` — the extension host has no live
  // reference into the webview's own React state (which alone holds the record's current values),
  // so the actual mutation (moveArrayElement/removeArrayElement/appendArrayElement, then writing
  // through the ordinary EDIT_FIELD write path) happens webview-side, the same computation the
  // keyboard accelerators (Insert/Delete/Ctrl+↑/Ctrl+↓, pure in-webview) already use. `fieldName`
  // is the row's own wire identity (context.rootField), matching arrayParentContext/
  // arrayElementContext's own convention.
  ARRAY_ADD: 'arrayAdd',
  ARRAY_REMOVE: 'arrayRemove',
  ARRAY_MOVE_UP: 'arrayMoveUp',
  ARRAY_MOVE_DOWN: 'arrayMoveDown',
  // Issue #231 (#426 Track 5: restored, simplified): VMAD's six structural-op right-click commands
  // (Add/Remove Script, Add/Remove Property, Set Script/Property Flags) all reduce, on Track 0's
  // backend, to the exact same shape EDIT_FIELD already carries — a VmadPath fieldPath
  // (`VMAD\<Script>` or `VMAD\<Script>\<Property>`) and an op-envelope value
  // (`{op: "add_script", ...}`, RecordFieldWriter.ApplyVmadField's own contract). Rather than six
  // near-identical broadcast shapes (the pre-#410 design, when the backend dispatch was itself
  // per-op-shaped), every command below resolves its own fieldPath/value and broadcasts this one
  // message; each open panel self-filters on `formKey` and commits through the identical
  // handleEditCell/EDIT_FIELD path every other gesture already uses — no new webview-side
  // computation at all, unlike the array-op broadcasts above.
  VMAD_STRUCTURAL_OP: 'vmadStructuralOp',
  // Issue #231: Add Property is the one structural op that collects more than a single native
  // prompt can hold (name, type, and a type-appropriate value) — #229's own deliberate exception,
  // a webview-rendered dialog rather than a QuickPick chain. This broadcast only tells the
  // matching panel which script/plugin to open it for; the dialog's own confirm computes the
  // fieldPath/value itself and commits through the ordinary write path, the same as every other
  // gesture — no reply travels back through this message.
  VMAD_OPEN_ADD_PROPERTY: 'vmadOpenAddProperty',
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
  // #426: the FormKey picker moved off the webview (which cannot call
  // vscode.window.createQuickPick itself — only the extension host can) onto a native QuickPick.
  // `seed` is the current reference (empty string when there is none), shown in the QuickPick's
  // value and used to pre-select the matching item; `validTypes` is the field's allowed record
  // types, same filter the picker always applied (pre-#410 #210, resurrected unchanged).
  OPEN_FORM_KEY_PICKER: 'openFormKeyPicker',
  // #426 Track 5: the condition-function picker moved off the webview the same way the FormKey
  // picker did — onto a native `showQuickPick` over the loaded game's function catalogue
  // (bounded, game-scoped, fetched once — no per-keystroke search, unlike OPEN_FORM_KEY_PICKER
  // above). `seed` is the condition's current function; the extension host sorts it to the front
  // of the QuickPick's item array (showQuickPick has no activeItem option the way createQuickPick
  // does, so array order is the only way to pre-highlight an item).
  OPEN_CONDITION_FUNCTION_PICKER: 'openConditionFunctionPicker',
  // #426: a `string`-typed value cell's double click — the *only* type/gesture combination where
  // double-click's target differs from second-click/F2's (see ScalarCell's own doc comment), so
  // this is the one new open-trigger message this ticket adds beyond the FormKey picker. `value`
  // seeds the tab; `readOnly` is decided by the webview (it already knows the column's own
  // editability) rather than re-derived on the extension-host side. The extension host owns
  // turning `recordLabel`/`fieldName`/`plugin` into a filesystem-safe path — a host-only concern
  // (only it touches the filesystem), so the webview hands over identity, not a pre-built path.
  OPEN_EXTENDED_EDITOR: 'openExtendedEditor',
} as const;

export type LogLevel = 'debug' | 'info' | 'warn';

// #410/ADR-0041: this bridge carried reads only while the record editor was a viewer. Most of what
// #410 removed stays removed — the pending-cell and column-header command broadcasts, the
// revert-group confirm, the clipboard read — because those were the *pending-change* surface, not
// editing as such. #415 rebuilds editing on text (EDIT_FIELD); #426 restores the remaining editor
// gestures on the same write path, starting with the FormKey picker (OPEN_FORM_KEY_PICKER /
// FORM_KEY_PICKED) — a native-surface request/reply, not a pending-change concept, so it comes
// back exactly as it stood before #410.
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
      // #272 / ADR-0036: required alongside `plugin`, consistent with every other column-identity
      // payload above — folds into the temp-file path (extendedEditorPath's own directory
      // segment) so two same-filename columns never alias onto one file.
      origin: string;
      readOnly: boolean;
      // Issue #242: FocusedCell's own disk/pending discriminant (#232) — absent (disk cell) is
      // every call site's own meaning unless it's the pending column's own.
      column?: 'pending';
    };

// Issue #227 (#426 Track 4: restored): the shape of a `data-vscode-context` payload VS Code
// parses and hands to the invoked command — never travels through `postMessage` itself, so these
// live beside (not inside) WebviewToExtension/ExtensionToWebview, the two commands below only
// need them for typing `ctx`. `recordUtils.ts`'s `arrayElementContext`/`arrayParentContext` build
// these; `combineVscodeContexts` there turns one (or several, once Track 5's VMAD contexts join
// them) into the actual attribute string.
export interface ArrayElementContext {
  webviewSection: 'arrayElement';
  formKey: string;
  plugin: string;
  origin: string;
  fieldName: string;
  index: number;
  canMoveUp: boolean;
  canMoveDown: boolean;
  preventDefaultContextMenuItems: true;
}

export interface ArrayParentContext {
  webviewSection: 'arrayParent';
  formKey: string;
  plugin: string;
  origin: string;
  fieldName: string;
  preventDefaultContextMenuItems: true;
}

// Issue #231 (#426 Track 5: restored): same mechanism as ArrayElementContext/ArrayParentContext
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

export type ExtensionToWebview =
  | { type: typeof EXTENSION_TO_WEBVIEW.LOAD_RECORD; formKey: string }
  | { type: typeof EXTENSION_TO_WEBVIEW.SESSION_CONFLICTS_COMPUTED }
  | { type: typeof EXTENSION_TO_WEBVIEW.RECORD_EDITED; formKey: string }
  | { type: typeof EXTENSION_TO_WEBVIEW.FORM_KEY_PICKED; requestId: string; formKey: string | null }
  | { type: typeof EXTENSION_TO_WEBVIEW.CONDITION_FUNCTION_PICKED; requestId: string; functionName: string | null }
  | { type: typeof EXTENSION_TO_WEBVIEW.EXTENDED_EDITOR_COMMITTED; requestId: string; value: string }
  | { type: typeof EXTENSION_TO_WEBVIEW.EXTENDED_EDITOR_CLOSED; requestId: string }
  | { type: typeof EXTENSION_TO_WEBVIEW.ARRAY_ADD; formKey: string; plugin: string; origin: string; fieldName: string }
  | { type: typeof EXTENSION_TO_WEBVIEW.ARRAY_REMOVE; formKey: string; plugin: string; origin: string; fieldName: string; index: number }
  | { type: typeof EXTENSION_TO_WEBVIEW.ARRAY_MOVE_UP; formKey: string; plugin: string; origin: string; fieldName: string; index: number }
  | { type: typeof EXTENSION_TO_WEBVIEW.ARRAY_MOVE_DOWN; formKey: string; plugin: string; origin: string; fieldName: string; index: number }
  | { type: typeof EXTENSION_TO_WEBVIEW.VMAD_STRUCTURAL_OP; formKey: string; plugin: string; origin: string; fieldPath: string; value: unknown }
  | { type: typeof EXTENSION_TO_WEBVIEW.VMAD_OPEN_ADD_PROPERTY; formKey: string; plugin: string; origin: string; scriptName: string };

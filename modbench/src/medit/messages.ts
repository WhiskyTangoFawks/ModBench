export const EXTENSION_TO_WEBVIEW = {
  LOAD_RECORD: 'loadRecord',
  // #208: the pending-cell right-click menu is now a native `webview/context` contribution —
  // its Save Group / Revert Group commands run in the extension host but the work (HTTP via
  // RecordSessionClient, the multi-member confirm dialog, the partial-save/stale-reindex
  // banner) only exists in the webview, so the command handler broadcasts down to every open
  // record panel and each one self-filters on whether `changeId` is one of its own pending
  // changes (a changeId is a global id, unique across every open record — see
  // PendingChangesTreeProvider.resolveChange — so at most one panel ever acts on a given
  // broadcast). Reveal needs no such message: resolving a changeId to a Pending Changes tree
  // node is already extension-host-only work (recordPanelMessageRouter.revealPendingChange),
  // so the native command calls it directly and never touches the webview.
  PENDING_CELL_SAVE_GROUP: 'pendingCellSaveGroup',
  PENDING_CELL_REVERT_GROUP: 'pendingCellRevertGroup',
  // #209: the column-header menu is a native `webview/context` contribution too, but unlike the
  // pending-cell commands above, none of these five actions' real work moved to the extension
  // host — Copy All to Pending / Copy as New Record / Add Master need field data
  // (`overrideMap`/`currentMasters`) that only exists in this webview's already-loaded
  // CompareResult, and Copy as Override / Remove already had their own working webview-side
  // fetch (RecordSessionClient.copyTo/removeOverride) that the extension host would otherwise
  // have to re-derive. So the command handler's only extension-host-side job is resolving *which*
  // plugin (QuickPick, mutable-list-plus-"New Plugin…" for the copy actions, all-loaded-plugins-
  // minus-current-masters for Add Master) — then it broadcasts the resolved target down to every
  // open record panel, same self-filtering shape as Save/Revert Group above but keyed on
  // `formKey` (there is no changeId here) so only the panel actually showing the mutated record
  // acts on it.
  COLUMN_HEADER_COPY_ALL_TO_PENDING: 'columnHeaderCopyAllToPending',
  COLUMN_HEADER_COPY_AS_NEW_RECORD: 'columnHeaderCopyAsNewRecord',
  COLUMN_HEADER_COPY_AS_OVERRIDE: 'columnHeaderCopyAsOverride',
  COLUMN_HEADER_REMOVE_OVERRIDE: 'columnHeaderRemoveOverride',
  COLUMN_HEADER_ADD_MASTER: 'columnHeaderAddMaster',
  // #210: the FormKey picker's reply — unlike every message above, this is a direct reply to the
  // one panel that asked (via `requestId`, matched by the webview-side pickFormKey bridge), never
  // a broadcast: the QuickPick that produced it only ever existed for that one request, so there
  // is no "which panel does this belong to" question to answer. `formKey: null` means the user
  // dismissed the picker (Escape/blur) — the caller leaves its field unchanged, same as the
  // deleted inline FormKeyPicker's onClose.
  FORM_KEY_PICKED: 'formKeyPicked',
  // #211: same direct-reply shape as FORM_KEY_PICKED above (keyed by requestId, never a
  // broadcast) — the condition-function picker's QuickPick only ever exists for the one request
  // that opened it. `functionName: null` means the user dismissed the picker (Escape/blur) — the
  // caller leaves the condition's function unchanged, same convention as FORM_KEY_PICKED.
  CONDITION_FUNCTION_PICKED: 'conditionFunctionPicked',
  // #212: same direct-reply shape as FORM_KEY_PICKED/CONDITION_FUNCTION_PICKED above (keyed by
  // requestId, never a broadcast) — the native modal warning only ever exists for the one
  // revert-group confirmation that opened it. `confirmed: false` covers both an explicit Cancel
  // and dismissing the modal (Escape/clicking outside) — VS Code's modal `showWarningMessage`
  // resolves `undefined` either way, so there is no distinct "dismissed" state to preserve, same
  // as the deleted RevertGroupConfirm's onCancel not distinguishing the two.
  REVERT_GROUP_CONFIRMED: 'revertGroupConfirmed',
  // #212: same shape again, for the native input box that replaced the add-script dialog.
  // `name: null` means the box was dismissed (Escape/blur) — the caller adds nothing, same as
  // the deleted AddScriptDialog's onCancel. An empty/whitespace name never reaches here: the
  // extension host's `validateInput` blocks accepting one, the same rule the deleted dialog's
  // `confirmDisabled` enforced client-side.
  ADD_SCRIPT_NAME_PICKED: 'addScriptNamePicked',
  // #227: the array element/parent right-click menu (Add / Remove / Move Up / Move Down) is a
  // native `webview/context` contribution, same shape as #208/#209 above — the command runs in
  // the extension host, which has no live reference to the webview's React state, so it
  // broadcasts to every open record panel and each self-filters on `formKey` (there is no
  // changeId here, same reasoning as the column-header messages). Unlike every broadcast above,
  // there is no async work at all on the extension-host side (no HTTP, no picker, no confirm) —
  // the handler just repackages data-vscode-context's payload and posts it. One message type per
  // action (not a shared type + direction flag), matching this file's existing convention of a
  // discriminated member per action rather than a parameterized one. The keyboard accelerators
  // (Insert/Delete/Ctrl+↑/Ctrl+↓) never go through this bridge — they call the same
  // recordUtils.ts mutation functions directly from DiskCell's onKeyDown, since onArrayEdit/
  // onArrayAdd are pure in-webview state with no platform boundary to cross (unlike Ctrl+C's
  // clipboard write, which genuinely needs the extension host).
  ARRAY_ADD: 'arrayAdd',
  ARRAY_REMOVE: 'arrayRemove',
  ARRAY_MOVE_UP: 'arrayMoveUp',
  ARRAY_MOVE_DOWN: 'arrayMoveDown',
  // #225: Ctrl+V's clipboard read — `vscode.env.clipboard.readText()` is extension-host-only, the
  // same reasoning as #224's COPY_TO_CLIPBOARD write. Unlike that fire-and-forget message, the
  // webview needs the text back to coerce and commit itself, so this is a direct reply keyed by
  // `requestId` (never a broadcast), the same shape as FORM_KEY_PICKED/REVERT_GROUP_CONFIRMED
  // above — the read only ever exists for the one Ctrl+V that asked.
  CLIPBOARD_READ: 'clipboardRead',
  // #230: the extended editor's commit — unlike every *_PICKED/*_CONFIRMED reply above (resolved
  // once, then done), a real editor tab can be saved more than once while it stays open, so this
  // is not a one-shot reply: the extension host posts one of these per `Ctrl+S` against the temp
  // file it opened for `requestId`, and the webview's nativeBridge keeps that `requestId`'s
  // callback registered (not deleted after the first message) until EXTENDED_EDITOR_CLOSED
  // arrives. `value` is the file's full saved content — the same string a normal commit would
  // carry through `onCommit`.
  EXTENDED_EDITOR_COMMITTED: 'extendedEditorCommitted',
  // #230: fired once, when the user closes the tab (`onDidCloseTextDocument`) — the signal
  // nativeBridge needs to delete its `requestId -> onCommit` map entry so a session that opens
  // many fields' extended editors over time doesn't accumulate one stale entry per tab ever
  // opened. Carries no value: closing commits nothing beyond whatever EXTENDED_EDITOR_COMMITTED
  // messages already arrived before it.
  EXTENDED_EDITOR_CLOSED: 'extendedEditorClosed',
} as const;

export const WEBVIEW_TO_EXTENSION = {
  OPEN_RECORD: 'openRecord',
  OPEN_RECORD_BESIDE: 'openRecordBeside',
  // #174: posted after every successful pending-change mutation (stage/copy/remove/save/revert)
  // so the extension host's Pending Changes tree — a separate process from this webview,
  // bridged only by postMessage — refreshes instead of going stale.
  PENDING_CHANGED: 'pendingChanged',
  // #200: the webview has no route to the 'Modbench' output channel (#198) of its own — it's a
  // separate process, bridged only by postMessage. The webview composes the full message text
  // (it has the plugin/field/record identity); the router on the other end just forwards it to
  // the matching leveled call.
  LOG: 'log',
  // #210: the FormKey picker moved off the webview (which cannot call vscode.window.createQuickPick
  // itself — only the extension host can) onto a native QuickPick. Every FormKeyCell/
  // VmadObjectEditor/AddPropertyDialog call site posts this and awaits the matching
  // FORM_KEY_PICKED reply (see pickFormKey in the webview) instead of rendering the old inline
  // picker. `seed` is the current reference (empty string when there is none, e.g. adding a new
  // property) — shown in the QuickPick's value and used to pre-select the matching item.
  // `validTypes` is the field's allowed record types, same filter the deleted picker applied.
  OPEN_FORM_KEY_PICKER: 'openFormKeyPicker',
  // #211: the condition-function picker moved off the webview the same way #210 moved the
  // FormKey picker — onto a native `showQuickPick` over the loaded game's function catalogue
  // (bounded, game-scoped, fetched once — no per-keystroke search, unlike OPEN_FORM_KEY_PICKER
  // above). `seed` is the condition's current function; the extension host sorts it to the front
  // of the QuickPick's item array (showQuickPick has no activeItem option — array order is the
  // only way to pre-highlight an item) instead of pre-selecting via `.activeItems` the way the
  // FormKey QuickPick does.
  OPEN_CONDITION_FUNCTION_PICKER: 'openConditionFunctionPicker',
  // #212: the multi-member revert-group confirmation moved off the webview's own ModalShell
  // (which cannot call vscode.window.showWarningMessage itself — only the extension host can)
  // onto a native modal warning. `detail` is the already-composed "recordType / formKey ·
  // fieldPath" listing of every linked edit — built here, not on the extension-host side, since
  // the webview already holds the PendingChange[] members from `client.groupMembers()` and
  // nothing needs fetching (unlike OPEN_FORM_KEY_PICKER/OPEN_CONDITION_FUNCTION_PICKER above,
  // where the extension host owns the PluginRepository fetch that shapes their picker items).
  OPEN_REVERT_GROUP_CONFIRM: 'openRevertGroupConfirm',
  // #212: the add-script dialog moved off the webview's ModalShell onto a native input box —
  // same "webview can't call the native API itself" reasoning as every bridge above. No seed:
  // the deleted AddScriptDialog always started from an empty name.
  OPEN_ADD_SCRIPT_NAME: 'openAddScriptName',
  // #224: Ctrl+C's clipboard write — `vscode.env.clipboard.writeText` is extension-host-only
  // (webview clipboard access isn't guaranteed), so DiffRow posts the already-computed model
  // value (modelValue.ts) up here. Unlike every *Picker/*Confirm/*Name bridge above, this is
  // fire-and-forget: nothing needs to come back, so there is no requestId and no matching
  // EXTENSION_TO_WEBVIEW reply type — the webview never learns whether the write succeeded, the
  // same shape PENDING_CHANGED/LOG already use below.
  COPY_TO_CLIPBOARD: 'copyToClipboard',
  // #225: Ctrl+V's clipboard read — the counterpart to COPY_TO_CLIPBOARD, but unlike that
  // fire-and-forget write, the webview needs the text back to coerce and commit itself. Follows
  // the *Picker/*Confirm/*Name request/reply shape above (`requestId`, matched by CLIPBOARD_READ)
  // rather than COPY_TO_CLIPBOARD's shape, for exactly that reason.
  READ_CLIPBOARD: 'readClipboard',
  // #230: a `string`-typed value cell's double click — the *only* type/gesture combination where
  // double-click's target differs from second-click/F2's (see ScalarCell's own doc comment), so
  // this is the one new open-trigger message this ticket adds. `value` seeds the tab; `readOnly`
  // is decided by the webview (it already knows the column's own editability) rather than
  // re-derived on the extension-host side. The extension host owns turning `recordLabel`/
  // `fieldName`/`plugin` into a filesystem-safe path — a host-only concern (only it touches the
  // filesystem), so the webview hands over identity, not a pre-built path.
  OPEN_EXTENDED_EDITOR: 'openExtendedEditor',
} as const;

export type LogLevel = 'debug' | 'info' | 'warn';

export type WebviewToExtension =
  | { type: typeof WEBVIEW_TO_EXTENSION.OPEN_RECORD; formKey: string }
  | { type: typeof WEBVIEW_TO_EXTENSION.OPEN_RECORD_BESIDE; formKey: string }
  | { type: typeof WEBVIEW_TO_EXTENSION.PENDING_CHANGED }
  | { type: typeof WEBVIEW_TO_EXTENSION.LOG; level: LogLevel; message: string }
  | { type: typeof WEBVIEW_TO_EXTENSION.OPEN_FORM_KEY_PICKER; requestId: string; seed: string; validTypes: string[] }
  | { type: typeof WEBVIEW_TO_EXTENSION.OPEN_CONDITION_FUNCTION_PICKER; requestId: string; seed: string }
  | { type: typeof WEBVIEW_TO_EXTENSION.OPEN_REVERT_GROUP_CONFIRM; requestId: string; detail: string }
  | { type: typeof WEBVIEW_TO_EXTENSION.OPEN_ADD_SCRIPT_NAME; requestId: string }
  | { type: typeof WEBVIEW_TO_EXTENSION.COPY_TO_CLIPBOARD; value: string }
  | { type: typeof WEBVIEW_TO_EXTENSION.READ_CLIPBOARD; requestId: string }
  | {
      type: typeof WEBVIEW_TO_EXTENSION.OPEN_EXTENDED_EDITOR; requestId: string; value: string;
      recordLabel: string; fieldName: string; plugin: string; readOnly: boolean;
    };

// #227: same broadcast-and-self-filter shape as PendingCellContext/ColumnHeaderContext above,
// carried by an array's parent-row cell (arrayParent, Add only) or an array-element cell
// (arrayElement, Remove/Move Up/Move Down). `fieldName` is the array's own top-level field name
// (arrays never nest inside structs in this codebase's model, so no parent-path is needed);
// `index` locates the element within it. No `immutable`/`isSortable` flag here — unlike
// ColumnHeaderContext's `when`-clause gating, DiffRow only emits this attribute at all when the
// column is mutable and the array is unsorted (mirroring the #142 arrayEdit/onArrayAdd gate), so
// the attribute's mere presence is the only gate needed, matching PendingCellContext's precedent.
// `canMoveUp`/`canMoveDown` are the one exception: package.json's `when` clause for those two
// commands gates on them the same way it gates columnHeader.removeOverride on `!immutable` — a
// boundary element (first/last) has nothing to move onto, and the AC's "absent, not disabled"
// principle for a sorted array applies just as much to a boundary move (xEdit itself greys the
// item out instead — `mniViewMoveUp.Enabled := ... Element.CanMoveUp`, xeMainForm.pas — but a
// declarative `webview/context` menu has no disabled state to render, so omitting is the nearest
// native equivalent, same reasoning ADR-0034 already accepts for the sorted-array case).
export interface ArrayElementContext {
  webviewSection: 'arrayElement';
  formKey: string;
  plugin: string;
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
  fieldName: string;
  preventDefaultContextMenuItems: true;
}

export type ExtensionToWebview =
  | { type: typeof EXTENSION_TO_WEBVIEW.LOAD_RECORD; formKey: string }
  | { type: typeof EXTENSION_TO_WEBVIEW.PENDING_CELL_SAVE_GROUP; changeId: string }
  | { type: typeof EXTENSION_TO_WEBVIEW.PENDING_CELL_REVERT_GROUP; changeId: string }
  | { type: typeof EXTENSION_TO_WEBVIEW.COLUMN_HEADER_COPY_ALL_TO_PENDING; formKey: string; sourcePlugin: string; targetPlugin: string }
  | { type: typeof EXTENSION_TO_WEBVIEW.COLUMN_HEADER_COPY_AS_NEW_RECORD; formKey: string; sourcePlugin: string; targetPlugin: string }
  | { type: typeof EXTENSION_TO_WEBVIEW.COLUMN_HEADER_COPY_AS_OVERRIDE; formKey: string; targetPlugin: string }
  | { type: typeof EXTENSION_TO_WEBVIEW.COLUMN_HEADER_REMOVE_OVERRIDE; formKey: string; plugin: string }
  | { type: typeof EXTENSION_TO_WEBVIEW.COLUMN_HEADER_ADD_MASTER; formKey: string; plugin: string; newMaster: string }
  | { type: typeof EXTENSION_TO_WEBVIEW.FORM_KEY_PICKED; requestId: string; formKey: string | null }
  | { type: typeof EXTENSION_TO_WEBVIEW.CONDITION_FUNCTION_PICKED; requestId: string; functionName: string | null }
  | { type: typeof EXTENSION_TO_WEBVIEW.REVERT_GROUP_CONFIRMED; requestId: string; confirmed: boolean }
  | { type: typeof EXTENSION_TO_WEBVIEW.ADD_SCRIPT_NAME_PICKED; requestId: string; name: string | null }
  | { type: typeof EXTENSION_TO_WEBVIEW.ARRAY_ADD; formKey: string; plugin: string; fieldName: string }
  | { type: typeof EXTENSION_TO_WEBVIEW.ARRAY_REMOVE; formKey: string; plugin: string; fieldName: string; index: number }
  | { type: typeof EXTENSION_TO_WEBVIEW.ARRAY_MOVE_UP; formKey: string; plugin: string; fieldName: string; index: number }
  | { type: typeof EXTENSION_TO_WEBVIEW.ARRAY_MOVE_DOWN; formKey: string; plugin: string; fieldName: string; index: number }
  | { type: typeof EXTENSION_TO_WEBVIEW.CLIPBOARD_READ; requestId: string; value: string | null }
  | { type: typeof EXTENSION_TO_WEBVIEW.EXTENDED_EDITOR_COMMITTED; requestId: string; value: string }
  | { type: typeof EXTENSION_TO_WEBVIEW.EXTENDED_EDITOR_CLOSED; requestId: string };

// #208: the merged `data-vscode-context` object VS Code's webview preload forwards as a
// `webview/context` command's sole argument — shared shape between the cell (recordUtils.ts'
// pendingCellContext, which produces the JSON string a cell's attribute carries) and the
// extension-host command handlers (extension.ts' registerPendingCellCommands, which consume it).
export interface PendingCellContext {
  webviewSection: 'pendingCell';
  changeId: string;
  preventDefaultContextMenuItems: true;
}

// #209: same mechanism as PendingCellContext above, carried by each plugin column header's `<th>`
// instead of a pending cell. `plugin` is the right-clicked column's own plugin — the "source" that
// copy actions exclude from their target QuickPick and Remove/Add Master act on directly. `masters`
// is the header record's current (pending-aware) masters list, needed by modbench.columnHeader.
// addMaster to compute its candidate list (all loaded plugins minus self minus already-a-master —
// deliberately NOT the mutable-only filter the copy actions use, see recordUtils.ts) without a
// round trip back into the webview just to ask. `immutable`/`isHeaderRecord` back the native
// menu's `when` clauses (Remove absent on an immutable column; Add Master only on the header
// record's own column, ADR-0033 — no standalone control once an action is right-click-reachable).
export interface ColumnHeaderContext {
  webviewSection: 'columnHeader';
  formKey: string;
  plugin: string;
  immutable: boolean;
  isHeaderRecord: boolean;
  masters: string[];
  preventDefaultContextMenuItems: true;
}

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
  | { type: typeof WEBVIEW_TO_EXTENSION.OPEN_ADD_SCRIPT_NAME; requestId: string };

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
  | { type: typeof EXTENSION_TO_WEBVIEW.ADD_SCRIPT_NAME_PICKED; requestId: string; name: string | null };

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

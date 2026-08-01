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
} as const;

export type LogLevel = 'debug' | 'info' | 'warn';

export type WebviewToExtension =
  | { type: typeof WEBVIEW_TO_EXTENSION.OPEN_RECORD; formKey: string }
  | { type: typeof WEBVIEW_TO_EXTENSION.OPEN_RECORD_BESIDE; formKey: string }
  | { type: typeof WEBVIEW_TO_EXTENSION.PENDING_CHANGED }
  | { type: typeof WEBVIEW_TO_EXTENSION.LOG; level: LogLevel; message: string };

export type ExtensionToWebview =
  | { type: typeof EXTENSION_TO_WEBVIEW.LOAD_RECORD; formKey: string }
  | { type: typeof EXTENSION_TO_WEBVIEW.PENDING_CELL_SAVE_GROUP; changeId: string }
  | { type: typeof EXTENSION_TO_WEBVIEW.PENDING_CELL_REVERT_GROUP; changeId: string }
  | { type: typeof EXTENSION_TO_WEBVIEW.COLUMN_HEADER_COPY_ALL_TO_PENDING; formKey: string; sourcePlugin: string; targetPlugin: string }
  | { type: typeof EXTENSION_TO_WEBVIEW.COLUMN_HEADER_COPY_AS_NEW_RECORD; formKey: string; sourcePlugin: string; targetPlugin: string }
  | { type: typeof EXTENSION_TO_WEBVIEW.COLUMN_HEADER_COPY_AS_OVERRIDE; formKey: string; targetPlugin: string }
  | { type: typeof EXTENSION_TO_WEBVIEW.COLUMN_HEADER_REMOVE_OVERRIDE; formKey: string; plugin: string }
  | { type: typeof EXTENSION_TO_WEBVIEW.COLUMN_HEADER_ADD_MASTER; formKey: string; plugin: string; newMaster: string };

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

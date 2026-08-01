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
  | { type: typeof EXTENSION_TO_WEBVIEW.PENDING_CELL_REVERT_GROUP; changeId: string };

// #208: the merged `data-vscode-context` object VS Code's webview preload forwards as a
// `webview/context` command's sole argument — shared shape between the cell (recordUtils.ts'
// pendingCellContext, which produces the JSON string a cell's attribute carries) and the
// extension-host command handlers (extension.ts' registerPendingCellCommands, which consume it).
export interface PendingCellContext {
  webviewSection: 'pendingCell';
  changeId: string;
  preventDefaultContextMenuItems: true;
}

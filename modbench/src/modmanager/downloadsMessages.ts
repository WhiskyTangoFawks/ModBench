import type { DownloadRow } from './mo2/downloads';

export const EXTENSION_TO_WEBVIEW = {
  ROWS_UPDATED: 'downloadsRowsUpdated',
  NO_FOLDER: 'downloadsNoFolder',
  ERROR: 'downloadsError',
} as const;

// #214: READY/REFRESH are the only messages the webview still posts — the row
// actions (Install/Visit on Nexus/Open File/Open Meta File/Reveal/Delete/
// Hide/Unhide) used to live here too, but their sole trigger (the hand-drawn
// row menu) is gone; they're native `webview/context` commands now
// (DownloadsPanel.ts' registerDownloadsRowCommands), which call the same
// extension-host action functions directly — no webview round trip needed.
export const WEBVIEW_TO_EXTENSION = {
  READY: 'downloadsReady',
  REFRESH: 'downloadsRefresh',
} as const;

export type ExtensionToWebview =
  | { type: typeof EXTENSION_TO_WEBVIEW.ROWS_UPDATED; rows: DownloadRow[] }
  | { type: typeof EXTENSION_TO_WEBVIEW.NO_FOLDER }
  | { type: typeof EXTENSION_TO_WEBVIEW.ERROR; message: string };

export type WebviewToExtension =
  | { type: typeof WEBVIEW_TO_EXTENSION.READY }
  | { type: typeof WEBVIEW_TO_EXTENSION.REFRESH };

// #214: the merged `data-vscode-context` object VS Code's webview preload forwards as a
// `webview/context` command's sole argument — shared shape between the row (mo2/downloads.ts'
// downloadRowContext, which produces the JSON string a row's attribute carries) and the
// extension-host command handlers (DownloadsPanel.ts' registerDownloadsRowCommands, which
// consume it). Same pattern as the record editor's PendingCellContext/ColumnHeaderContext (#208/#209).
export interface DownloadRowContext {
  webviewSection: 'downloadRow';
  name: string;
  /** Gates Open Meta File. */
  hasMeta: boolean;
  /** Gates Visit on Nexus. */
  hasModID: boolean;
  /** Selects Hide vs Unhide in the native menu's `when` clauses. */
  hidden: boolean;
  preventDefaultContextMenuItems: true;
}

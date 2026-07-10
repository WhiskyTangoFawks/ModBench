import type { DownloadRow } from './mo2/downloads';

export const EXTENSION_TO_WEBVIEW = {
  ROWS_UPDATED: 'downloadsRowsUpdated',
  NO_FOLDER: 'downloadsNoFolder',
  ERROR: 'downloadsError',
} as const;

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

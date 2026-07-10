import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { readdir, stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildDownloadRows, type DownloadEntry } from './mo2/downloads';
import { EXTENSION_TO_WEBVIEW, WEBVIEW_TO_EXTENSION, type WebviewToExtension } from './downloadsMessages';
import { createDownloadsWatcher } from './downloadsWatcher';

const PANEL_KEY = '__downloads__';

function buildHtml(scriptUri: string, cspSource: string): string {
  const nonce = crypto.randomBytes(16).toString('base64');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; script-src 'nonce-${nonce}' ${cspSource}; style-src ${cspSource} 'unsafe-inline';">
</head>
<body>
  <div id="root"></div>
  <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

/** Best-effort read of an archive's `.meta` sidecar text; absent -> undefined
 *  (a metaless archive is a valid Downloaded row, per the spec). */
async function readMetaText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

async function scanDownloads(instanceRoot: string): Promise<DownloadEntry[] | undefined> {
  const dir = join(instanceRoot, 'downloads');
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  // .meta sidecars are suppressed as rows by buildDownloadRows, not filtered
  // here too — one place owns the suppression rule.
  return Promise.all(
    names.map(async (name) => {
      const filePath = join(dir, name);
      const [info, metaText] = await Promise.all([stat(filePath), readMetaText(`${filePath}.meta`)]);
      return { name, size: info.size, mtimeMs: info.mtimeMs, metaText };
    }),
  );
}

export function openDownloadsPanel(
  context: vscode.ExtensionContext,
  openPanels: Map<string, vscode.WebviewPanel>,
  instanceRoot: string,
  log: (msg: string) => void,
): void {
  const existing = openPanels.get(PANEL_KEY);
  if (existing) {
    existing.reveal();
    return;
  }

  const panel = vscode.window.createWebviewPanel('modbench.downloads', 'Downloads', vscode.ViewColumn.One, {
    enableScripts: true,
    localResourceRoots: [vscode.Uri.file(join(context.extensionPath, 'out', 'webview'))],
  });
  openPanels.set(PANEL_KEY, panel);

  const refresh = async (): Promise<void> => {
    try {
      const entries = await scanDownloads(instanceRoot);
      if (!entries) {
        await panel.webview.postMessage({ type: EXTENSION_TO_WEBVIEW.NO_FOLDER });
        return;
      }
      await panel.webview.postMessage({ type: EXTENSION_TO_WEBVIEW.ROWS_UPDATED, rows: buildDownloadRows(entries) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`[DownloadsPanel] scanning downloads/ failed: ${message}`);
      // Inline UI + log, not a toast (ADR-0026: background/recoverable failure).
      await panel.webview.postMessage({
        type: EXTENSION_TO_WEBVIEW.ERROR,
        message: 'Failed to read the downloads folder — see the Modbench output log.',
      });
    }
  };

  panel.webview.onDidReceiveMessage((msg: unknown) => {
    if (typeof msg === 'object' && msg !== null && 'type' in msg) {
      const m = msg as WebviewToExtension;
      // READY fires the first scan: the extension waits for the webview's own
      // message listener to be live rather than posting immediately after
      // `webview.html` is set, which would race the page still loading.
      if (m.type === WEBVIEW_TO_EXTENSION.READY || m.type === WEBVIEW_TO_EXTENSION.REFRESH) void refresh();
    }
  });

  const watcher = createDownloadsWatcher(instanceRoot, () => void refresh());
  panel.onDidDispose(() => {
    watcher.dispose();
    openPanels.delete(PANEL_KEY);
  });

  const scriptUri = panel.webview.asWebviewUri(
    vscode.Uri.file(join(context.extensionPath, 'out', 'webview', 'assets', 'downloads.js')),
  );
  panel.webview.html = buildHtml(scriptUri.toString(), panel.webview.cspSource);
}

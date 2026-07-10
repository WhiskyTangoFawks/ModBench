import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { readdir, stat, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildDownloadRows, parseDownloadMeta, setInstalledInText, type DownloadEntry } from './mo2/downloads';
import { EXTENSION_TO_WEBVIEW, WEBVIEW_TO_EXTENSION, type WebviewToExtension } from './downloadsMessages';
import { createDownloadsWatcher } from './downloadsWatcher';
import { deleteDownload } from './deleteDownload';
import { readGameName } from './mo2/modOrganizerIni';
import { nexusSlugForGame } from './mo2/nexusSlug';

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

/** Row Install action: delegate to the existing installFromArchive command
 *  (pre-supplying the archive path so no file-picker appears), and on
 *  success write `installed=true` back to the .meta sidecar. The Downloads
 *  panel's file-watcher picks up that .meta change and refreshes the row's
 *  Status on its own — no explicit refresh needed here. */
async function installArchive(instanceRoot: string, name: string, log: (msg: string) => void): Promise<void> {
  const archivePath = join(instanceRoot, 'downloads', name);
  let installed = false;
  try {
    installed = (await vscode.commands.executeCommand<boolean>(
      'modbench.modList.installFromArchive',
      archivePath,
    )) ?? false;
    if (!installed) return;
    const metaPath = `${archivePath}.meta`;
    const metaText = (await readMetaText(metaPath)) ?? '';
    await writeFile(metaPath, setInstalledInText(metaText), 'utf8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (installed) {
      // ADR-0026: integrity/silent-wrong-state (partial save) — the mod IS
      // installed, only its Downloads bookkeeping failed. Must not read as
      // "install failed", or the user may retry and get a duplicate mod.
      log(`[DownloadsPanel] "${name}" installed but updating its Downloads status failed: ${message}`);
      void vscode.window.showWarningMessage(
        `Modbench: "${name}" was installed, but its Downloads status could not be updated — see the Modbench output log.`,
      );
    } else {
      log(`[DownloadsPanel] installing "${name}" failed: ${message}`);
      // ADR-0026: explicit user action failed -> error notification + log.
      void vscode.window.showErrorMessage(`Modbench: Failed to install "${name}".`);
    }
  }
}

/** Run a per-row navigational action, surfacing any failure per ADR-0026
 *  (an explicit user action failing → error notification + output log). The
 *  thin nav actions (open/reveal/visit) can all reject — e.g. a `.meta` raced
 *  away, an OS with no handler — so none may be fire-and-forget. */
async function runRowAction(
  label: string,
  name: string,
  log: (msg: string) => void,
  action: () => Promise<void>,
): Promise<void> {
  try {
    await action();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`[DownloadsPanel] ${label} for "${name}" failed: ${message}`);
    void vscode.window.showErrorMessage(`Modbench: ${label} for "${name}" failed.`);
  }
}

/** Row Delete action: move the archive and its `.meta` sidecar (if any) to the
 *  system trash, behind a modal confirmation. All sequencing/ordering lives in
 *  the injected-dep `deleteDownload` (unit-tested); this adapter only supplies
 *  the VS Code surface — the native confirm, trash via `workspace.fs.delete`
 *  with `useTrash`, and ADR-0026 failure surfacing. The file-watcher removes the
 *  row on its own once the archive leaves disk. Never touches the installed mod. */
async function deleteArchive(instanceRoot: string, name: string, log: (msg: string) => void): Promise<void> {
  const archivePath = join(instanceRoot, 'downloads', name);
  const metaPath = `${archivePath}.meta`;
  await deleteDownload({
    archivePath,
    metaPath,
    confirm: async () =>
      (await vscode.window.showWarningMessage(
        `Delete "${name}"? The archive and its .meta file (if any) will be moved to the system trash.`,
        { modal: true },
        'Delete',
      )) === 'Delete',
    metaExists: async () => (await readMetaText(metaPath)) !== undefined,
    trash: async (path) => {
      await vscode.workspace.fs.delete(vscode.Uri.file(path), { useTrash: true });
    },
    reportFailure: (message) => {
      log(`[DownloadsPanel] deleting "${name}" failed: ${message}`);
      // ADR-0026: explicit user action failed -> error notification + log.
      void vscode.window.showErrorMessage(`Modbench: Failed to delete "${name}".`);
    },
  });
}

/** Row Visit-on-Nexus action: read the archive's `.meta` for the Nexus mod id
 *  and the instance's game for the slug, then open the mod's Nexus page. No-op
 *  when there's no mod id (the webview also gates the action off). */
async function visitOnNexus(instanceRoot: string, name: string): Promise<void> {
  const metaText = await readMetaText(join(instanceRoot, 'downloads', `${name}.meta`));
  const modID = metaText ? parseDownloadMeta(metaText).modID : undefined;
  if (!modID) return;
  const slug = nexusSlugForGame(readGameName(await readFile(join(instanceRoot, 'ModOrganizer.ini'), 'utf8')));
  await vscode.env.openExternal(vscode.Uri.parse(`https://www.nexusmods.com/${slug}/mods/${modID}`));
}

/** Map each webview message type to its handler. READY fires the first scan:
 *  the extension waits for the webview's own message listener to be live rather
 *  than posting immediately after `webview.html` is set, which would race the
 *  page still loading. REFRESH is the manual re-scan. The rest are per-row
 *  actions carrying the row `name`. */
function buildMessageHandlers(
  instanceRoot: string,
  log: (msg: string) => void,
  refresh: () => Promise<void>,
): Record<string, (name: string) => void> {
  return {
    [WEBVIEW_TO_EXTENSION.READY]: () => void refresh(),
    [WEBVIEW_TO_EXTENSION.REFRESH]: () => void refresh(),
    [WEBVIEW_TO_EXTENSION.INSTALL]: (name) => void installArchive(instanceRoot, name, log),
    [WEBVIEW_TO_EXTENSION.VISIT_NEXUS]: (name) =>
      void runRowAction('Visit on Nexus', name, log, () => visitOnNexus(instanceRoot, name)),
    // OS-open the archive in the system's associated application.
    [WEBVIEW_TO_EXTENSION.OPEN_FILE]: (name) =>
      void runRowAction('Open File', name, log, async () => {
        await vscode.env.openExternal(vscode.Uri.file(join(instanceRoot, 'downloads', name)));
      }),
    // Open the `.meta` sidecar in the editor (webview gates this off when absent).
    [WEBVIEW_TO_EXTENSION.OPEN_META]: (name) =>
      void runRowAction('Open Meta File', name, log, async () => {
        await vscode.window.showTextDocument(vscode.Uri.file(join(instanceRoot, 'downloads', `${name}.meta`)));
      }),
    // Reveal the archive in the OS file manager.
    [WEBVIEW_TO_EXTENSION.REVEAL]: (name) =>
      void runRowAction('Reveal in Explorer', name, log, async () => {
        await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(join(instanceRoot, 'downloads', name)));
      }),
    [WEBVIEW_TO_EXTENSION.DELETE]: (name) => void deleteArchive(instanceRoot, name, log),
  };
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

  const handlers = buildMessageHandlers(instanceRoot, log, refresh);
  panel.webview.onDidReceiveMessage((msg: unknown) => {
    if (typeof msg === 'object' && msg !== null && 'type' in msg) {
      const m = msg as WebviewToExtension;
      handlers[m.type]?.('name' in m ? m.name : '');
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

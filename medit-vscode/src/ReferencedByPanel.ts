import * as vscode from 'vscode';
import * as path from 'path';
import { buildWebviewHtml } from './webviewHtml';
import { WEBVIEW_TO_EXTENSION, type WebviewToExtension } from './messages';

export function openReferencedByPanel(
  context: vscode.ExtensionContext,
  openPanels: Map<string, vscode.WebviewPanel>,
  formKey: string,
  editorId: string | null | undefined,
  port: number,
  onOpenRecord: (formKey: string) => void,
  onOpenRecordBeside: (formKey: string) => void,
): void {
  const key = `__referenced_by__:${formKey}`;
  const existing = openPanels.get(key);
  if (existing) {
    existing.reveal();
    return;
  }

  const title = `Referenced By: ${editorId ?? formKey}`;
  const panel = vscode.window.createWebviewPanel('mEdit.referencedBy', title, vscode.ViewColumn.Beside, {
    enableScripts: true,
    localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'out', 'webview'))],
  });

  openPanels.set(key, panel);
  panel.onDidDispose(() => openPanels.delete(key));

  panel.webview.onDidReceiveMessage((msg: unknown) => {
    if (typeof msg === 'object' && msg !== null && 'type' in msg) {
      const m = msg as WebviewToExtension;
      switch (m.type) {
        case WEBVIEW_TO_EXTENSION.OPEN_RECORD:
          onOpenRecord(m.formKey);
          break;
        case WEBVIEW_TO_EXTENSION.OPEN_RECORD_BESIDE:
          onOpenRecordBeside(m.formKey);
          break;
      }
    }
  });

  const scriptUri = panel.webview.asWebviewUri(
    vscode.Uri.file(path.join(context.extensionPath, 'out', 'webview', 'assets', 'referencedBy.js'))
  );

  panel.webview.html = buildWebviewHtml({
    formKey,
    port,
    scriptUri: scriptUri.toString(),
    cspSource: panel.webview.cspSource,
  });
}

import * as crypto from 'node:crypto';
import * as vscode from 'vscode';

/** A page of the webview build: its script, the stylesheet the build emits for it when it imports
 *  any, and what is set on `window` before the script runs. */
export interface WebviewPage {
  readonly script: string;
  readonly stylesheet?: string;
  readonly globals?: Readonly<Record<string, unknown>>;
}

export function showWebviewPage(
  webview: Pick<vscode.Webview, 'options' | 'html' | 'cspSource' | 'asWebviewUri'>, extensionUri: vscode.Uri,
  { script, stylesheet, globals = {} }: WebviewPage,
): void {
  const root = vscode.Uri.joinPath(extensionUri, 'out', 'webview');
  webview.options = { enableScripts: true, localResourceRoots: [root] };
  const asset = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(root, 'assets', file)).toString();
  const { cspSource } = webview;
  const nonce = crypto.randomBytes(16).toString('base64');
  const assignments = Object.entries(globals).map(([name, value]) => `window.${name} = ${JSON.stringify(value)};`).join(' ');
  const link = stylesheet === undefined ? '' : `\n  <link rel="stylesheet" href="${asset(stylesheet)}">`;
  webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; script-src 'nonce-${nonce}' ${cspSource}; style-src ${cspSource} 'unsafe-inline'; font-src ${cspSource};">${link}
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}">${assignments}</script>
  <script type="module" src="${asset(script)}"></script>
</body>
</html>`;
}

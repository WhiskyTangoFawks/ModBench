import * as crypto from 'node:crypto';
import * as vscode from 'vscode';

function buildWebviewHtml(params: {
  scriptUri: string;
  styleUri: string;
  cspSource: string;
  globals: Readonly<Record<string, unknown>>;
}): string {
  const { scriptUri, styleUri, cspSource, globals } = params;
  const nonce = crypto.randomBytes(16).toString('base64');
  const assignments = Object.entries(globals).map(([name, value]) => `window.${name} = ${JSON.stringify(value)};`).join(' ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; script-src 'nonce-${nonce}' ${cspSource}; style-src ${cspSource} 'unsafe-inline'; font-src ${cspSource};">
  <link rel="stylesheet" href="${styleUri}">
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}">${assignments}</script>
  <script type="module" src="${scriptUri}"></script>
</body>
</html>`;
}

/** Loads one page of the webview build, its script and stylesheet named after it, with each of
 *  `globals` set on `window` before the script runs. */
export function showWebviewPage(
  webview: Pick<vscode.Webview, 'options' | 'html' | 'cspSource' | 'asWebviewUri'>, extensionUri: vscode.Uri, page: string, globals: Readonly<Record<string, unknown>> = {},
): void {
  const root = vscode.Uri.joinPath(extensionUri, 'out', 'webview');
  webview.options = { enableScripts: true, localResourceRoots: [root] };
  const asset = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(root, 'assets', file)).toString();
  webview.html = buildWebviewHtml({
    scriptUri: asset(`${page}.js`), styleUri: asset(`${page}.css`), cspSource: webview.cspSource, globals,
  });
}

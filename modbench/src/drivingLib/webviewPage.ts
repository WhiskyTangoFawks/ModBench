import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import { WEBVIEW_STYLESHEET } from '../wire/webviewPages';

/** A page of the webview build: its script, and what is set on `window` before the script runs.
 *  Every page links the build's one stylesheet.
 *  A page that shows images names the one folder it may load them from. */
export interface WebviewPage {
  readonly script: string;
  readonly imagesFolder?: vscode.Uri;
  readonly globals?: Readonly<Record<string, unknown>>;
}

const inlineScriptJson = (value: unknown): string => ((JSON.stringify(value) as string | undefined) ?? 'undefined').replace(/</g, '\\u003c');

export function showWebviewPage(
  webview: Pick<vscode.Webview, 'options' | 'html' | 'cspSource' | 'asWebviewUri'>, extensionUri: vscode.Uri,
  { script, globals = {}, imagesFolder }: WebviewPage,
): void {
  const root = vscode.Uri.joinPath(extensionUri, 'out', 'webview');
  webview.options = { enableScripts: true, localResourceRoots: imagesFolder === undefined ? [root] : [root, imagesFolder] };
  const asset = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(root, 'assets', file)).toString();
  const { cspSource } = webview;
  const nonce = crypto.randomBytes(16).toString('base64');
  const images = imagesFolder === undefined ? '' : ` img-src ${cspSource};`;
  const assignments = Object.entries(globals).map(([name, value]) => `window.${name} = ${inlineScriptJson(value)};`).join(' ');
  webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; script-src 'nonce-${nonce}' ${cspSource}; style-src ${cspSource} 'unsafe-inline'; font-src ${cspSource};${images}">
  <link rel="stylesheet" href="${asset(WEBVIEW_STYLESHEET)}">
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}">${assignments}</script>
  <script type="module" src="${asset(script)}"></script>
</body>
</html>`;
}

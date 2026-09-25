import * as crypto from 'node:crypto';

export function buildWebviewHtml(params: {
  formKey: string | undefined;
  port: number;
  scriptUri: string;
  cspSource: string;
  // Named in the body's webview context, so every right-click menu names the panel it came from.
  panelId: string;
}): string {
  const { formKey, port, scriptUri, cspSource, panelId } = params;
  const nonce = crypto.randomBytes(16).toString('base64');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; script-src 'nonce-${nonce}' ${cspSource}; style-src ${cspSource} 'unsafe-inline'; connect-src http://localhost:${port};">
</head>
<body data-vscode-context='${JSON.stringify({ panelId })}'>
  <div id="root"></div>
  <script nonce="${nonce}">window.mEditFormKey = ${JSON.stringify(formKey ?? '')}; window.mEditBackendPort = ${port};</script>
  <script type="module" src="${scriptUri}"></script>
</body>
</html>`;
}

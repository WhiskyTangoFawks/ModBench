import * as crypto from 'node:crypto';

export function buildWebviewHtml(params: {
  formKey: string;
  scriptUri: string;
  styleUri: string;
  cspSource: string;
}): string {
  const { formKey, scriptUri, styleUri, cspSource } = params;
  const nonce = crypto.randomBytes(16).toString('base64');
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
  <script nonce="${nonce}">window.mEditFormKey = ${JSON.stringify(formKey)};</script>
  <script type="module" src="${scriptUri}"></script>
</body>
</html>`;
}

import * as crypto from 'crypto';

export function buildWebviewHtml(params: {
  formKey: string | undefined;
  port: number;
  scriptUri: string;
  cspSource: string;
  // #544: "Compare with winner" opening a freshly-created panel already scoped to one plugin's
  // peer/winner origin pair — undefined for every ordinary open. This is LOAD_RECORD's own
  // deltaScope field, for a panel that didn't exist yet to receive a postMessage — the
  // initial-page-load counterpart, same relationship formKey/mEditFormKey above already has to
  // that message.
  deltaScope?: { plugin: string; winnerOrigin: string; peerOrigin: string };
}): string {
  const { formKey, port, scriptUri, cspSource, deltaScope } = params;
  const nonce = crypto.randomBytes(16).toString('base64');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; script-src 'nonce-${nonce}' ${cspSource}; style-src ${cspSource} 'unsafe-inline'; connect-src http://localhost:${port};">
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}">window.mEditFormKey = ${JSON.stringify(formKey ?? '')}; window.mEditBackendPort = ${port}; window.mEditDeltaScope = ${JSON.stringify(deltaScope ?? null)};</script>
  <script type="module" src="${scriptUri}"></script>
</body>
</html>`;
}

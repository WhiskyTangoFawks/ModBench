import * as vscode from 'vscode';

const SCHEME = 'medit-record';

/** Identity only, never working-tree state: a URI changing on every dirty/clean transition
 *  would churn VS Code's tree identity. Synthetic rather than the real source path, which
 *  `vscode.git` decorates with its own answer. */
export function recordResourceUri(plugin: string, origin: string | undefined, formKey: string): vscode.Uri {
  const path = ['', plugin, origin ?? '', formKey].map((s, i) => (i === 0 ? s : encodeURIComponent(s))).join('/');
  return vscode.Uri.from({ scheme: SCHEME, path });
}

export interface RecordResourceIdentity {
  plugin: string;
  origin: string;
  formKey: string;
}

/** Undefined for any URI outside the `medit-record:` scheme, so a decoration provider asked
 *  about someone else's URI can guard on it. */
export function parseRecordResourceUri(uri: vscode.Uri): RecordResourceIdentity | undefined {
  if (uri.scheme !== SCHEME) return undefined;
  const parts = uri.path.split('/').map(decodeURIComponent);
  if (parts.length < 4) return undefined;
  const [, plugin, origin, formKey] = parts;
  return { plugin, origin, formKey };
}

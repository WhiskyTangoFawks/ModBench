import * as vscode from 'vscode';

export const RECORD_EDITOR_VIEW_TYPE = 'modbench.record';

const SCHEME = 'modbench-record';
const SUFFIX = '.modbench-record';
const PICK_PATH = `/_pick${SUFFIX}`;

/** A record tab's address. `undefined` is the no-record-yet picker tab (`modbench.openCompare`). */
export function recordUri(formKey: string | undefined): vscode.Uri {
  const path = formKey === undefined ? PICK_PATH : `/${encodeURIComponent(formKey)}${SUFFIX}`;
  return vscode.Uri.from({ scheme: SCHEME, path });
}

export function formKeyOfRecordUri(uri: vscode.Uri): string | undefined {
  if (uri.path === PICK_PATH || !uri.path.endsWith(SUFFIX)) return undefined;
  return decodeURIComponent(uri.path.slice(1, -SUFFIX.length));
}

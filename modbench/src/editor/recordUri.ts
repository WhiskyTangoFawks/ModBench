import * as vscode from 'vscode';

export const RECORD_EDITOR_VIEW_TYPE = 'modbench.record';
export const RECORD_FILE_VIEW_TYPE = 'modbench.recordFile';

const SCHEME = 'modbench-record';
const SUFFIX = '.modbench-record';

export function recordUri(formKey: string): vscode.Uri {
  return vscode.Uri.from({ scheme: SCHEME, path: `/${encodeURIComponent(formKey)}${SUFFIX}` });
}

export function formKeyOfRecordUri(uri: vscode.Uri): string {
  return decodeURIComponent(uri.path.slice(1, -SUFFIX.length));
}

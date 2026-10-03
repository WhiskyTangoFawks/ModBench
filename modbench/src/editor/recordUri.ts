import * as vscode from 'vscode';

export const RECORD_EDITOR_VIEW_TYPE = 'modbench.record';

const SCHEME = 'modbench-record';
const SUFFIX = '.modbench-record';

/** `origin` is held by a plugin header alone, whose FormKey names only its plugin's file name
 *  (ADR-0012). */
export interface RecordAddress { formKey: string; origin?: string }

export function recordUri({ formKey, origin }: RecordAddress): vscode.Uri {
  return vscode.Uri.from({
    scheme: SCHEME,
    path: `/${encodeURIComponent(formKey)}${SUFFIX}`,
    query: origin === undefined ? '' : new URLSearchParams({ origin }).toString(),
  });
}

export function formKeyOfRecordUri(uri: vscode.Uri): string {
  return decodeURIComponent(uri.path.slice(1, -SUFFIX.length));
}

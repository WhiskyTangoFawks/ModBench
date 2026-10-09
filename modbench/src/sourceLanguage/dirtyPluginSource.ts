import * as vscode from 'vscode';
import { CHILD_RECORD_SCHEME } from '../drivingLib/recordDocument';
import { isPluginSourcePath } from '../instanceAdapter/instanceAdapter';

const CONTAINER_SCHEMES = new Set(['file', CHILD_RECORD_SCHEME]);

/** Each unsaved plugin-source file's text by absolute path. A child record's document is its container's whole
 *  text; the document over a file that `changedAt` ranks latest holds it.  */
export function dirtyPluginSource(changedAt: (uri: vscode.Uri) => number): { path: string; text: string }[] {
  const held = new Map<string, { text: string; at: number }>();
  for (const document of vscode.workspace.textDocuments) {
    if (!document.isDirty || !CONTAINER_SCHEMES.has(document.uri.scheme)) continue;
    const path = document.uri.fsPath;
    if (!isPluginSourcePath(path)) continue;
    const at = changedAt(document.uri);
    const rival = held.get(path);
    if (rival === undefined || at >= rival.at) held.set(path, { text: document.getText(), at });
  }
  return [...held].map(([path, { text }]) => ({ path, text }));
}

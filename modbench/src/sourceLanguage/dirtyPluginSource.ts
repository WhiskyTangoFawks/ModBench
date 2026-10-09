import * as vscode from 'vscode';
import { CHILD_RECORD_SCHEME } from '../drivingLib/recordDocument';
import { isPluginSourcePath } from '../instanceAdapter/instanceAdapter';

const CONTAINER_SCHEMES = new Set(['file', CHILD_RECORD_SCHEME]);

export const isPluginSourceDocument = ({ scheme, fsPath }: vscode.Uri): boolean =>
  CONTAINER_SCHEMES.has(scheme) && isPluginSourcePath(fsPath);

/** Each unsaved plugin-source file's text by absolute path. A child record's document holds its
 *  container's whole text, the one its file's document holds. */
export function dirtyPluginSource(): { path: string; text: string }[] {
  const held = new Map<string, string>();
  for (const document of vscode.workspace.textDocuments) {
    if (document.isDirty && isPluginSourceDocument(document.uri)) held.set(document.uri.fsPath, document.getText());
  }
  return [...held].map(([path, text]) => ({ path, text }));
}

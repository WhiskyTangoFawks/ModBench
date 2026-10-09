import * as vscode from 'vscode';
import { relative, isAbsolute } from 'node:path';
import { CONTAINER_SCHEMES } from '../drivingLib/recordDocument';
import { isPluginSourcePath } from '../instanceAdapter/instanceAdapter';

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

const isUnder = (folder: string, path: string): boolean => {
  const inside = relative(folder, path);
  return inside !== '' && !inside.startsWith('..') && !isAbsolute(inside);
};

/** Saves each unsaved plugin-source document under `folder` and answers the paths VS Code left unsaved. */
export async function saveDirtyPluginSource(folder: string): Promise<string[]> {
  const inFolder = () => vscode.workspace.textDocuments.filter(
    (document) => document.isDirty && isPluginSourceDocument(document.uri) && isUnder(folder, document.uri.fsPath));
  for (const document of inFolder()) {
    if (document.isDirty) await document.save();
  }
  return [...new Set(inFolder().map((document) => document.uri.fsPath))];
}

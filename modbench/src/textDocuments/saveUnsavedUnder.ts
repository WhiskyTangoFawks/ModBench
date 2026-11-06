import * as vscode from 'vscode';
import { isPluginSourceDocument } from './pluginSource';

const forward = (path: string): string => path.replace(/\\/g, '/').toLowerCase();

const isUnder = (folder: string, path: string): boolean => forward(path).startsWith(`${forward(folder).replace(/\/$/, '')}/`);

/** Saves each unsaved document under `folder` that `picked` picks, and answers the paths VS Code left unsaved. */
export async function saveUnsavedUnder(folder: string, picked: (path: string) => boolean): Promise<string[]> {
  const unsaved = () => vscode.workspace.textDocuments.filter(({ uri, isDirty }) =>
    isDirty && isPluginSourceDocument(uri, picked) && isUnder(folder, uri.fsPath));
  for (const document of unsaved()) {
    if (document.isDirty) await document.save();
  }
  return [...new Set(unsaved().map(({ uri }) => uri.fsPath))];
}

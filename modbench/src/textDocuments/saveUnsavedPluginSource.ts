import * as vscode from 'vscode';
import { CONTAINER_SCHEMES } from './recordDocument';

const forward = (path: string): string => path.replace(/\\/g, '/').toLowerCase();

const isUnder = (folder: string, path: string): boolean => forward(path).startsWith(`${forward(folder).replace(/\/$/, '')}/`);

/** Saves each unsaved document of the plugin source under `folder`, and answers the paths VS Code left unsaved. */
export async function saveUnsavedPluginSource(folder: string, isPluginSource: (path: string) => boolean): Promise<string[]> {
  const unsaved = () => vscode.workspace.textDocuments.filter(({ uri, isDirty }) =>
    isDirty && CONTAINER_SCHEMES.has(uri.scheme) && isPluginSource(uri.fsPath) && isUnder(folder, uri.fsPath));
  for (const document of unsaved()) {
    if (document.isDirty) await document.save();
  }
  return [...new Set(unsaved().map(({ uri }) => uri.fsPath))];
}

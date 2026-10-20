import * as vscode from 'vscode';
import { isPluginSourceDocument, type IsPluginSource } from './pluginSource';

const forward = (path: string): string => path.replace(/\\/g, '/').toLowerCase();

const isUnder = (folder: string, path: string): boolean => forward(path).startsWith(`${forward(folder).replace(/\/$/, '')}/`);

/** Saves each unsaved document of the plugin source under `folder`, and answers the paths VS Code left unsaved. */
export async function saveUnsavedPluginSource(folder: string, isPluginSource: IsPluginSource): Promise<string[]> {
  const unsaved = () => vscode.workspace.textDocuments.filter(({ uri, isDirty }) =>
    isDirty && isPluginSourceDocument(uri, isPluginSource) && isUnder(folder, uri.fsPath));
  for (const document of unsaved()) {
    if (document.isDirty) await document.save();
  }
  return [...new Set(unsaved().map(({ uri }) => uri.fsPath))];
}

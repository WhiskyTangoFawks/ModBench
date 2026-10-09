import * as vscode from 'vscode';
import { isPluginSourcePath } from '../instanceAdapter/instanceAdapter';

/** The documents under plugin source holding changes VS Code has not saved, by absolute path. */
export const dirtyPluginSource = (): { path: string; text: string }[] => vscode.workspace.textDocuments
  .filter(({ isDirty, uri }) => isDirty && uri.scheme === 'file' && isPluginSourcePath(uri.fsPath))
  .map((document) => ({ path: document.uri.fsPath, text: document.getText() }));

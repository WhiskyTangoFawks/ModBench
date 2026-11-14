import * as vscode from 'vscode';
import { heldText } from '../textDocuments/heldText';

/** A file's text as VS Code shows it: its document's when one is open, else the file on disk, which no document opens.
 *  A file that is gone has none. */
export const sourceFileText = (savedText: (path: string) => Promise<string | undefined>) => async (path: string): Promise<string> => {
  const open = vscode.workspace.textDocuments.find((document) => document.uri.fsPath === path);
  return open ? heldText(open) : await savedText(path) ?? '';
};

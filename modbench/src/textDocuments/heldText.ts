import * as vscode from 'vscode';

export const heldText = (document: Pick<vscode.TextDocument, 'getText'>): string => document.getText();

export const isUnsaved = (document: Pick<vscode.TextDocument, 'isDirty'>): boolean => document.isDirty;

/** Each file's unsaved text, by its path. */
export const unsavedTexts = (): (readonly [path: string, text: string])[] =>
  vscode.workspace.textDocuments
    .filter((document) => document.uri.scheme === 'file' && isUnsaved(document))
    .map((document) => [document.uri.fsPath, heldText(document)] as const);

export const onHeldTextChanged = (document: object, changed: () => void): vscode.Disposable =>
  vscode.workspace.onDidChangeTextDocument((change) => {
    if (change.document === document && change.contentChanges.length > 0) changed();
  });

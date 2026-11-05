import * as vscode from 'vscode';

export const heldText = (document: Pick<vscode.TextDocument, 'getText'>): string => document.getText();

export const isUnsaved = (document: Pick<vscode.TextDocument, 'isDirty'>): boolean => document.isDirty;

/** The unsaved text of each file `isHeld` takes, by its path. */
export const unsavedTexts = (isHeld: (path: string) => boolean): ReadonlyMap<string, string> =>
  new Map(vscode.workspace.textDocuments
    .filter((document) => document.uri.scheme === 'file' && isUnsaved(document) && isHeld(document.uri.fsPath))
    .map((document) => [document.uri.fsPath, heldText(document)]));

export const onHeldTextChanged = (document: object, changed: () => void): vscode.Disposable =>
  vscode.workspace.onDidChangeTextDocument((change) => {
    if (change.document === document && change.contentChanges.length > 0) changed();
  });

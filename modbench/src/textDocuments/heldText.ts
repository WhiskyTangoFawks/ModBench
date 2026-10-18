import * as vscode from 'vscode';

export const heldText = (document: Pick<vscode.TextDocument, 'getText'>): string => document.getText();

export const isUnsaved = (document: Pick<vscode.TextDocument, 'isDirty'>): boolean => document.isDirty;

export const onHeldTextChanged = (document: object, changed: () => void): vscode.Disposable =>
  vscode.workspace.onDidChangeTextDocument((change) => {
    if (change.document === document && change.contentChanges.length > 0) changed();
  });

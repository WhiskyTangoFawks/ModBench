import * as vscode from 'vscode';

/** A document's text as VS Code holds it. */
export const heldText = (document: Pick<vscode.TextDocument, 'getText'>): string => document.getText();

/** Whether VS Code holds changes to `document` that are not saved. */
export const isUnsaved = (document: Pick<vscode.TextDocument, 'isDirty'>): boolean => document.isDirty;

/** Calls `changed` whenever `document`'s text changes. */
export const onHeldTextChanged = (document: Pick<vscode.TextDocument, 'getText'>, changed: () => void): vscode.Disposable =>
  vscode.workspace.onDidChangeTextDocument((change) => {
    if (change.document === document && change.contentChanges.length > 0) changed();
  });

import * as vscode from 'vscode';

/** A document's text as VS Code holds it. */
export const heldText = (document: vscode.TextDocument): string => document.getText();

/** Whether VS Code holds changes to `document` that are not saved. */
export const isUnsaved = (document: vscode.TextDocument): boolean => document.isDirty;

/** Calls `changed` whenever `document`'s text changes. */
export const onHeldTextChanged = (document: vscode.TextDocument, changed: () => void): vscode.Disposable =>
  vscode.workspace.onDidChangeTextDocument((change) => {
    if (change.document === document && change.contentChanges.length > 0) changed();
  });

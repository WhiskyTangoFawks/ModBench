import * as vscode from 'vscode';

/** ADR-0019 surfacing: one modal question, answered by the pressed button's label or `undefined`
 *  for the native cancel. Injected, so the module that asks is testable without a VS Code host;
 *  named here, not re-declared per asking module. */
export type AskQuestion = (
  message: string, options: { modal: true; detail?: string }, ...buttons: string[]
) => Thenable<string | undefined>;

/** A question is a warning modal because that is the one message API whose modal form both
 *  carries a detail and returns which button was pressed. */
export const askQuestion: AskQuestion = (message, options, ...buttons) =>
  Promise.resolve(vscode.window.showWarningMessage(message, options, ...buttons));

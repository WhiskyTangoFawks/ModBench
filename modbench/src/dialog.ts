import * as vscode from 'vscode';
import type { AskQuestion } from './ports/dialog';

/** A question is a warning modal because that is the one message API whose modal form both
 *  carries a detail and returns which button was pressed. */
export const askQuestion: AskQuestion = (message, options, ...buttons) =>
  Promise.resolve(vscode.window.showWarningMessage(message, options, ...buttons));

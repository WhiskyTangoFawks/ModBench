import * as vscode from 'vscode';
import { offerEslFlagRemoval, type EslFlagRemovalTarget } from './eslFlagRemovalPrompt';
import type { MEditClient } from './client';
import { askQuestion } from '../dialog';

/** Binds `offerEslFlagRemoval` to `vscode.window`; the core (eslFlagRemovalPrompt.ts) stays
 *  `vscode`-free and testable. Shared by Editing's create/copy-as-new and the Plugins view's
 *  compile retry — one binder, not a copy per caller. */
export async function promptEslFlagRemoval(
  target: EslFlagRemovalTarget, refusalReason: string, verb: string, repository: Pick<MEditClient, 'editRecord'>,
): Promise<boolean> {
  return offerEslFlagRemoval(
    target, refusalReason, verb, repository, askQuestion,
    message => void vscode.window.showErrorMessage(message),
  );
}

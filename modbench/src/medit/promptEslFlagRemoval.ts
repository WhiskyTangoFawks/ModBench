import * as vscode from 'vscode';
import { offerEslFlagRemoval, type EslFlagRemovalTarget } from './eslFlagRemovalPrompt';
import type { MEditClient } from './client';
import type { AskQuestion } from '../dialog';

/** Binds only the refusal report to `vscode.window`; the question comes from the caller's own
 *  dialog seam (ADR-0019), so the core (eslFlagRemovalPrompt.ts) stays `vscode`-free. One binder
 *  for create, copy-as-new and the compile retry. */
export async function promptEslFlagRemoval(
  target: EslFlagRemovalTarget, refusalReason: string, verb: string, repository: Pick<MEditClient, 'editRecord'>,
  ask: AskQuestion,
): Promise<boolean> {
  return offerEslFlagRemoval(
    target, refusalReason, verb, repository, ask,
    message => void vscode.window.showErrorMessage(message),
  );
}

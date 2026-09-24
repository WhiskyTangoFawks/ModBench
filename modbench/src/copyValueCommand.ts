import * as vscode from 'vscode';
import type { Reporter } from './ports/reporter';
import { errorMessage } from './ports/errorMessage';

/** One surface's contribution to the catalog's one copy value id (commands.md, Record: copy
 *  value): its own text for this invocation, or `undefined` to defer to the next adapter. */
export interface CopyValueAdapter {
  text: (clicked: unknown, allSelected: readonly unknown[] | undefined) => string | undefined;
  reporterTag: string;
}

// The composition root's own dispatch: every surface the catalog names contributes an adapter
// here, tried in order, so no surface's module needs to know another surface exists.
export function registerCopyValueCommand(
  adapters: readonly CopyValueAdapter[], reporterFor: (tag: string) => Reporter,
): vscode.Disposable {
  return vscode.commands.registerCommand('modbench.record.copyValue',
    async (clicked?: unknown, allSelected?: unknown[]) => {
      for (const adapter of adapters) {
        const text = adapter.text(clicked, allSelected);
        if (text === undefined) continue;
        if (!text) return;
        try {
          await vscode.env.clipboard.writeText(text);
        } catch (err) {
          reporterFor(adapter.reporterTag).report('error', 'Could not copy to the clipboard.', errorMessage(err));
        }
        return;
      }
    });
}

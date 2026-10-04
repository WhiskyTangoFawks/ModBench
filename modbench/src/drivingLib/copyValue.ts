import * as vscode from 'vscode';
import type { Reporter } from '../ports/reporter';
import { errorMessage } from '../ports/errorMessage';

/** One surface's contribution to the catalog's one copy value id (commands.md, Every view): its
 *  own text for this invocation, or `undefined` to defer to the next adapter. */
export interface CopyValueAdapter {
  text: (clicked: unknown, allSelected: readonly unknown[] | undefined) => string | undefined;
  reporterTag: string;
}

// Adapters are tried in order, so no surface needs to know another exists. A palette call has no
// argument, so the focused view stands for the key its own Ctrl+C passes.
export function registerCopyValueCommand(
  adapters: readonly CopyValueAdapter[], reporterFor: (tag: string) => Reporter,
  focusedViewId: () => string | undefined, nothingToCopy: () => void,
): vscode.Disposable {
  return vscode.commands.registerCommand('modbench.copyValue',
    async (clicked?: unknown, allSelected?: unknown[]) => {
      const viewId = focusedViewId();
      const invocation = clicked ?? (viewId === undefined ? undefined : { view: viewId });
      for (const adapter of adapters) {
        const text = adapter.text(invocation, allSelected);
        if (text === undefined) continue;
        if (!text) return;
        try {
          await vscode.env.clipboard.writeText(text);
        } catch (err) {
          reporterFor(adapter.reporterTag).report('error', 'Could not copy to the clipboard.', errorMessage(err));
        }
        return;
      }
      nothingToCopy();
    });
}

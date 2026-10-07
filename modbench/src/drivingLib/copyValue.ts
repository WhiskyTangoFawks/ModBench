import * as vscode from 'vscode';
import type { Reporter } from '../ports/reporter';
import { errorMessage } from '../ports/errorMessage';
import { gestureEntry, kindGuard, selectionArgument, type GestureEntry, type KindedRow, type RowOf } from './gestureEntry';

/** One surface's contribution to the catalog's one copy value id (commands.md, Every view): its
 *  own text for this invocation, or `undefined` to defer to the next adapter. */
export interface CopyValueAdapter {
  text: (clicked: unknown, allSelected: readonly unknown[] | undefined) => string | undefined;
  reporterTag: string;
}

/** The view whose key passed `value` as its `args`, since a key cannot name the rows it acts on. */
export function keyArgsView(value: unknown): string | undefined {
  const view: unknown = typeof value === 'object' && value !== null ? Reflect.get(value, 'view') : undefined;
  return typeof view === 'string' ? view : undefined;
}

/** Whether `value` is the `args` the view's own key passes. */
export const isKeyArgs = (value: unknown, view: string): boolean => keyArgsView(value) === view;

/** A tree view's text for the catalog's copy value: the whole view selection for its key, the
 *  selected rows for a right-clicked row, one line each. `undefined` for anything else, so another
 *  view's invocation defers. */
export function viewCopyValueText<Row extends KindedRow, K extends Row['kind']>(
  view: string, kinds: readonly K[], lineOf: (row: RowOf<Row, K>) => string, viewSelection: () => readonly Row[],
): CopyValueAdapter['text'] {
  const isCopied = kindGuard<Row>()(kinds);
  const lines = (entry: GestureEntry<Row>) => selectionArgument(entry, ...kinds).map(lineOf).join('\n');
  return (clicked, allSelected) => {
    if (isKeyArgs(clicked, view)) return lines({ selection: viewSelection() });
    if (!isCopied(clicked)) return undefined;
    const selected = allSelected?.length ? allSelected.filter(isCopied) : undefined;
    return lines(gestureEntry<Row>(clicked, selected, viewSelection));
  };
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

import type * as vscode from 'vscode';

type SelectionChange = vscode.TreeViewSelectionChangeEvent<unknown>;
export function fakeView(): { selection: readonly unknown[]; select(rows: readonly unknown[]): void; onDidChangeSelection: vscode.Event<SelectionChange> } {
  const listeners: ((e: SelectionChange) => void)[] = [];
  const view = {
    selection: [] as readonly unknown[],
    select(rows: readonly unknown[]) {
      view.selection = rows;
      for (const listener of listeners) listener({ selection: rows });
    },
    onDidChangeSelection: (listener: (e: SelectionChange) => void) => {
      listeners.push(listener);
      return { dispose: () => undefined };
    },
  };
  return view;
}

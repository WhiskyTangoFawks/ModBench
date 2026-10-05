import type * as vscode from 'vscode';

type SelectionView<T> = Pick<vscode.TreeView<T>, 'selection' | 'onDidChangeSelection'>;

/** VS Code reports no selection from a tree's change until the rebuilt tree hands its rows back,
 *  so the last selection the user made answers until the view reports one. */
export function survivingSelection<T>(view: SelectionView<T>): { rows: () => readonly T[]; dispose: () => void } {
  let held: readonly T[] = view.selection;
  const subscription = view.onDidChangeSelection((e) => { held = e.selection; });
  return {
    rows: () => (view.selection.length > 0 ? view.selection : held),
    dispose: () => subscription.dispose(),
  };
}

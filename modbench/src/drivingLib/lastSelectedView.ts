import * as vscode from 'vscode';

type SelectableView = Pick<vscode.TreeView<unknown>, 'selection' | 'onDidChangeSelection'>;
type OwnDisposable = (disposable: vscode.Disposable) => unknown;
type ViewIn = readonly { id: string; view: SelectableView }[];

/** The Argument of view on Nexus. Each surface's row adapts itself to it, so a mod row and a
 *  downloaded file row reach the same gesture. */
export interface NexusModRow {
  readonly nexusModId?: string;
}

const hasNexusModId = (row: unknown): row is { nexusModId: string } =>
  typeof row === 'object' && row !== null && 'nexusModId' in row && typeof row.nexusModId === 'string';

/** No stable API names the focused view, so the palette's view on Nexus opens the row selected in
 *  the view last selected in, and `modbench.mod.nexusRowIn` names that view while it has one. */
export function nexusRowInLastSelectedView(own: OwnDisposable, views: ViewIn): () => NexusModRow | undefined {
  let last: SelectableView | undefined;
  const nexusRow = (): NexusModRow | undefined => {
    const [only, ...rest] = last?.selection ?? [];
    return rest.length === 0 && hasNexusModId(only) ? only : undefined;
  };
  for (const { id, view } of views) {
    own(view.onDidChangeSelection(() => {
      last = view;
      void vscode.commands.executeCommand('setContext', 'modbench.mod.nexusRowIn', nexusRow() && id);
    }));
  }
  return nexusRow;
}

/** No stable API names the focused view, so a palette gesture views offer takes the selection of
 *  the view last selected in, and `contextKey`, when given, names that view. */
export function lastSelectedViewSelection(
  own: OwnDisposable, views: ViewIn, contextKey?: string,
): () => readonly unknown[] {
  let last: SelectableView | undefined;
  for (const { id, view } of views) {
    own(view.onDidChangeSelection(() => {
      last = view;
      if (contextKey !== undefined) void vscode.commands.executeCommand('setContext', contextKey, id);
    }));
  }
  return () => last?.selection ?? [];
}

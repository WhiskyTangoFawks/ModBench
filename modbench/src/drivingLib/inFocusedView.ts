import * as vscode from 'vscode';
import type { FocusedView } from './focusedView';

type OwnDisposable = (disposable: vscode.Disposable) => unknown;

/** The Argument of view on Nexus. Each surface's row adapts itself to it, so a mod row and a
 *  downloaded file row reach the same gesture. */
export interface NexusModRow {
  readonly nexusModId?: string;
}

const hasNexusModId = (row: unknown): row is { nexusModId: string } =>
  typeof row === 'object' && row !== null && 'nexusModId' in row && typeof row.nexusModId === 'string';

const setContext = (key: string, value: unknown): void => {
  void vscode.commands.executeCommand('setContext', key, value);
};

/** The palette's view on Nexus opens the row selected in the focused view among `viewIds`, and
 *  `contextKey` names that view while it has one. */
export function nexusRowInFocusedView(
  own: OwnDisposable, focused: FocusedView, viewIds: readonly string[], contextKey: string,
): () => NexusModRow | undefined {
  const nexusRow = (): NexusModRow | undefined => {
    const id = focused.id();
    const [only, ...rest] = id !== undefined && viewIds.includes(id) ? focused.selection() : [];
    return rest.length === 0 && hasNexusModId(only) ? only : undefined;
  };
  own(focused.onDidChange((id) => { setContext(contextKey, nexusRow() && id); }));
  return nexusRow;
}

/** A palette gesture views offer takes the selection of the focused view among `viewIds`, and
 *  `contextKey` names that view while it is one of them. */
export function selectionInFocusedView(
  own: OwnDisposable, focused: FocusedView, viewIds: readonly string[], contextKey: string,
): () => readonly unknown[] {
  const isOneOf = (id: string | undefined): id is string => id !== undefined && viewIds.includes(id);
  own(focused.onDidChange((id) => { setContext(contextKey, isOneOf(id) ? id : undefined); }));
  return () => (isOneOf(focused.id()) ? focused.selection() : []);
}

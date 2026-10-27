import type * as vscode from 'vscode';
import type { PluginAddress } from '../wire/pluginAddress';
import type { FocusedView } from './focusedView';

/** The rows of each view that a selection relates to (plugins.md, The highlight). */
export interface RelatedRows {
  readonly plugins: readonly PluginAddress[];
}

const NONE: RelatedRows = { plugins: [] };

/** A view that says which rows its selection relates to. */
export interface RelatesRows {
  related(selection: readonly unknown[]): RelatedRows;
}

/** A view that draws the highlight it is handed. */
export interface DrawsHighlight {
  highlight(related: RelatedRows): void;
}

/** One highlight answers one selection, the focused view's (Divergences, row 18): a view
 *  with no `RelatesRows` hands none, so a selection left in another view drives nothing.
 *  `changes` recomputes it when the rows change. */
export function highlightFollowingFocus(
  focused: FocusedView, relating: ReadonlyMap<string, RelatesRows>, drawing: readonly DrawsHighlight[],
  changes: (listener: () => void) => vscode.Disposable,
): vscode.Disposable {
  const hand = () => {
    const id = focused.id();
    const related = (id === undefined ? undefined : relating.get(id))?.related(focused.selection()) ?? NONE;
    for (const view of drawing) view.highlight(related);
  };
  const focusSubscription = focused.onDidChange(hand);
  const changeSubscription = changes(hand);
  return { dispose: () => { focusSubscription.dispose(); changeSubscription.dispose(); } };
}

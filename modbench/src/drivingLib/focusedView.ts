import type * as vscode from 'vscode';

type FollowedView = Pick<vscode.TreeView<unknown>, 'onDidChangeSelection'>;

export interface FocusedView {
  id(): string | undefined;
  /** Selecting in `view` makes it the focused one. */
  follow(id: string, view: FollowedView): vscode.Disposable;
  /** A surface that is no tree says it has the focus. */
  enter(id: string): void;
}

/** No stable API names the focused view, so it is the one last selected in or entered: copy
 *  value and the name filter, which every list offers, act on it. */
export function createFocusedView(): FocusedView {
  let last: string | undefined;
  return {
    id: () => last,
    follow: (id, view) => view.onDidChangeSelection(() => { last = id; }),
    enter: (id) => { last = id; },
  };
}

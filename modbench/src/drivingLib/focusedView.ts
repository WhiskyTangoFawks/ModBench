import type * as vscode from 'vscode';

type FollowedView = Pick<vscode.TreeView<unknown>, 'selection' | 'onDidChangeSelection'>;

export interface FocusedView {
  id(): string | undefined;
  /** The selection of the followed view last selected in; none while a surface that is no tree has
   *  the focus. */
  selection(): readonly unknown[];
  /** The selection of the followed view `id`, whichever view has the focus. */
  selectionOf(id: string): readonly unknown[];
  /** Selecting in `view` makes it the focused one. */
  follow(id: string, view: FollowedView): vscode.Disposable;
  /** A surface that is no tree says it has the focus. */
  enter(id: string): void;
  /** Called with the new focused view, after its selection is readable. */
  onDidChange(listener: (id: string) => void): vscode.Disposable;
}

/** No stable API names the focused view, so it is the one last selected in or entered: copy
 *  value, the name filter and every palette gesture that acts on a selection read it. */
export function createFocusedView(): FocusedView {
  let last: { id: string; view?: FollowedView } | undefined;
  const followed = new Map<string, FollowedView>();
  const listeners = new Set<(id: string) => void>();
  const focus = (next: { id: string; view?: FollowedView }): void => {
    last = next;
    for (const listener of [...listeners]) listener(next.id);
  };
  return {
    id: () => last?.id,
    selection: () => last?.view?.selection ?? [],
    selectionOf: (id) => followed.get(id)?.selection ?? [],
    follow: (id, view) => {
      followed.set(id, view);
      const subscription = view.onDidChangeSelection(() => { focus({ id, view }); });
      return { dispose: () => { followed.delete(id); subscription.dispose(); } };
    },
    enter: (id) => { focus({ id }); },
    onDidChange: (listener) => {
      listeners.add(listener);
      return { dispose: () => { listeners.delete(listener); } };
    },
  };
}

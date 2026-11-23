import * as vscode from 'vscode';
import { holdRedraws, releaseRedraws } from './heldRedraw';

/** What a command tells the view's progress: it is working, or it waits on a person and the view is not busy. */
export interface Progress {
  readonly working: () => void;
  readonly waiting: () => void;
}

/** A view's progress that is shown, and holds the view's redraw, while the command works, and neither while it waits
 *  (common.md, A gesture that writes, story 1). */
export function pausableProgress(viewId: string): Progress & { readonly done: () => Promise<void> } {
  let shown: { readonly release: () => void; readonly closed: Thenable<unknown> } | undefined;
  const close = (): Thenable<unknown> | undefined => {
    const closing = shown;
    if (closing === undefined) return undefined;
    shown = undefined;
    closing.release();
    releaseRedraws(viewId);
    return closing.closed;
  };
  return {
    working: () => {
      if (shown !== undefined) return;
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => { release = resolve; });
      shown = { release, closed: vscode.window.withProgress({ location: { viewId } }, () => held) };
      holdRedraws(viewId);
    },
    waiting: () => { void close(); },
    done: async () => { await close(); },
  };
}

import * as vscode from 'vscode';

/** What a command tells the view's progress: it is working, or it waits on a person and the view is not busy. */
export interface Progress {
  readonly working: () => void;
  readonly waiting: () => void;
}

/** A view's progress that is shown while the command works and closed while it waits. */
export function pausableProgress(viewId: string): Progress & { readonly done: () => Promise<void> } {
  let shown: { readonly release: () => void; readonly closed: Thenable<unknown> } | undefined;
  const close = (): Thenable<unknown> | undefined => {
    const closing = shown;
    shown = undefined;
    closing?.release();
    return closing?.closed;
  };
  return {
    working: () => {
      if (shown !== undefined) return;
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => { release = resolve; });
      shown = { release, closed: vscode.window.withProgress({ location: { viewId } }, () => held) };
    },
    waiting: () => { void close(); },
    done: async () => { await close(); },
  };
}

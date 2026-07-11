import * as vscode from 'vscode';

const DEBOUNCE_MS = 200;

/** Watches the instance's `overwrite/` folder; calls `onChange` on any create,
 *  change, or delete under it, so the Loadout's pinned Overwrite row appears the
 *  instant a purge deposits files and disappears the instant they're cleared —
 *  no manual refresh (modbench/CLAUDE.md: reactive over manual). Events are
 *  debounced: a purge sweeps many files at once, firing a burst of fs events;
 *  one re-render per burst is enough. Returned disposable owns the underlying
 *  watcher and cancels any pending debounced call. */
export function createOverwriteWatcher(instanceRoot: string, onChange: () => void): vscode.Disposable {
  const pattern = new vscode.RelativePattern(vscode.Uri.file(instanceRoot), 'overwrite/**');
  const watcher = vscode.workspace.createFileSystemWatcher(pattern);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const scheduleChange = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(onChange, DEBOUNCE_MS);
  };
  watcher.onDidCreate(scheduleChange);
  watcher.onDidChange(scheduleChange);
  watcher.onDidDelete(scheduleChange);

  return {
    dispose: () => {
      if (timer) clearTimeout(timer);
      watcher.dispose();
    },
  };
}

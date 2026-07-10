import * as vscode from 'vscode';

const DEBOUNCE_MS = 200;

/** Watches the instance's downloads/ folder; calls `onChange` on any create,
 *  change, or delete under it (archives or `.meta` sidecars alike — the
 *  caller just re-scans). Events are debounced: a single logical file
 *  operation (e.g. an archive write followed by its `.meta` sidecar write)
 *  fires several fs events in quick succession, and calling `onChange`
 *  (an async re-scan) once per event lets overlapping scans resolve out of
 *  order, leaving the webview showing a stale snapshot. Returned disposable
 *  owns the underlying watcher and cancels any pending debounced call. */
export function createDownloadsWatcher(instanceRoot: string, onChange: () => void): vscode.Disposable {
  const pattern = new vscode.RelativePattern(vscode.Uri.file(instanceRoot), 'downloads/**');
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

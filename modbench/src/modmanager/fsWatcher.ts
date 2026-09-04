import * as vscode from 'vscode';

const DEBOUNCE_MS = 200;

// Narrower than "`.git` anywhere in the path": the directory entry itself appearing or
// disappearing is a load-order-relevant change callers still need.
function isInsideGitDir(fsPath: string): boolean {
  const segments = fsPath.split(/[\\/]/);
  const gitIndex = segments.lastIndexOf('.git');
  return gitIndex !== -1 && gitIndex !== segments.length - 1;
}

/** An archive extraction or a purge fires a burst of fs events; one re-scan per burst is
 *  enough. A caller with its own coalescing passes `debounceMs` 0 rather than stack a second
 *  wait. */
export function createDebouncedFsWatcher(
  instanceRoot: string, glob: string, onChange: () => void, debounceMs: number = DEBOUNCE_MS,
): vscode.Disposable {
  const pattern = new vscode.RelativePattern(vscode.Uri.file(instanceRoot), glob);
  const watcher = vscode.workspace.createFileSystemWatcher(pattern);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const scheduleChange = (uri: vscode.Uri) => {
    if (isInsideGitDir(uri.fsPath)) return;
    clearTimeout(timer);
    timer = setTimeout(onChange, debounceMs);
  };
  watcher.onDidCreate(scheduleChange);
  watcher.onDidChange(scheduleChange);
  watcher.onDidDelete(scheduleChange);

  return {
    dispose: () => {
      clearTimeout(timer);
      watcher.dispose();
    },
  };
}

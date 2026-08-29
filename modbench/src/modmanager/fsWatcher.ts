import * as vscode from 'vscode';

const DEBOUNCE_MS = 200;

/** Shared debounced-watcher factory behind modsWatcher.ts and overwriteWatcher.ts: watches
 *  `glob` under `instanceRoot` and calls `onChange` on any create, change, or delete under it,
 *  so a change made outside Modbench (Explorer drag-in, hand-extracted archive, a purge) is
 *  picked up the instant it happens — no manual refresh (modbench/CLAUDE.md: reactive over
 *  manual). Events are debounced: an archive extraction or a purge drops/moves many files at
 *  once, firing a burst of fs events; one re-scan per burst is enough. Returned disposable owns
 *  the underlying watcher and cancels any in-flight debounced call. `clearTimeout` tolerates an
 *  undefined timer, so there's no need to guard it. */
export function createDebouncedFsWatcher(instanceRoot: string, glob: string, onChange: () => void): vscode.Disposable {
  const pattern = new vscode.RelativePattern(vscode.Uri.file(instanceRoot), glob);
  const watcher = vscode.workspace.createFileSystemWatcher(pattern);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const scheduleChange = () => {
    clearTimeout(timer);
    timer = setTimeout(onChange, DEBOUNCE_MS);
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

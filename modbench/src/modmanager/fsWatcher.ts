import * as vscode from 'vscode';

const DEBOUNCE_MS = 200;

/** True for a path *inside* a `.git` directory (any depth) — ADR-0041's per-mod working-tree
 *  plumbing (the compile journal marker, refs, objects, the index), none of which is a fact any
 *  of this watcher's consumers cares about (ADR-0044's reconcile trigger reads name/origin/slot/
 *  enabled/winning; git internals change none of them — #621). Deliberately narrower than "`.git`
 *  appears anywhere in the path": the `.git` directory entry itself appearing or disappearing is
 *  not filtered here — untracking/tracking a mod by hand, outside Modbench's own Track command,
 *  is only observable as that one event, and this watcher's callers still need it (root
 *  CLAUDE.md: never assume exclusive ownership of a file on disk). */
function isInsideGitDir(fsPath: string): boolean {
  const segments = fsPath.split(/[\\/]/);
  const gitIndex = segments.lastIndexOf('.git');
  return gitIndex !== -1 && gitIndex !== segments.length - 1;
}

/** Shared debounced-watcher factory behind modsWatcher.ts and overwriteWatcher.ts: watches
 *  `glob` under `instanceRoot` and calls `onChange` on any create, change, or delete under it
 *  (excluding `.git` internals — see `isInsideGitDir`), so a change made outside Modbench
 *  (Explorer drag-in, hand-extracted archive, a purge) is picked up the instant it happens — no
 *  manual refresh (modbench/CLAUDE.md: reactive over manual). Events are debounced: an archive
 *  extraction or a purge drops/moves many files at once, firing a burst of fs events; one re-scan
 *  per burst is enough. Returned disposable owns the underlying watcher and cancels any in-flight
 *  debounced call. `clearTimeout` tolerates an undefined timer, so there's no need to guard it.
 *
 *  `debounceMs` defaults to the historical 200ms; a caller with its own downstream coalescing
 *  (`loadOrderReconcile`'s `request()`, itself debounced) overrides it to 0 rather than stack a
 *  second, uncoordinated wait in front of that one (#621's mechanism 2). This is a latency
 *  change, not a coalescing one — `request()`'s own debounce timer is reset by every call and
 *  fires once, `debounceMs` after the last one, regardless of whether an extra wait sits upstream
 *  of it; removing that wait only moves *when* the shared timer starts, from ~200ms after the
 *  last raw event to ~0ms, which is what cuts total latency here from ~450ms to ~250ms. It does
 *  not, on its own, change how many reconcile cycles a burst produces — the sync's own debounce
 *  already dominates that outcome either way. */
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

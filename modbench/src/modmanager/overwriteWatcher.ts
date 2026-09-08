import type * as vscode from 'vscode';
import { createDebouncedFsWatcher } from './fsWatcher';

/** The pinned Overwrite row must appear and vanish with the folder's contents, without a
 *  manual refresh. A caller with its own coalescing passes `debounceMs` 0. */
export function createOverwriteWatcher(instanceRoot: string, onChange: () => void, debounceMs?: number): vscode.Disposable {
  return createDebouncedFsWatcher(instanceRoot, 'overwrite/**', onChange, debounceMs);
}

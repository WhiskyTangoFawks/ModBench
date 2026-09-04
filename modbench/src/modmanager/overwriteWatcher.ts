import type * as vscode from 'vscode';
import { createDebouncedFsWatcher } from './fsWatcher';

/** The pinned Overwrite row must appear and vanish with the folder's contents, without a
 *  manual refresh. */
export function createOverwriteWatcher(instanceRoot: string, onChange: () => void): vscode.Disposable {
  return createDebouncedFsWatcher(instanceRoot, 'overwrite/**', onChange);
}

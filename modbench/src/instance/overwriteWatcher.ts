import type * as vscode from 'vscode';
import { createDebouncedFsWatcher } from './fsWatcher';
import { OVERWRITE_GLOB } from '../mo2Files/layout';

/** The pinned Overwrite row must appear and vanish with the folder's contents, without a
 *  manual refresh. A caller with its own coalescing passes `debounceMs` 0. */
export function createOverwriteWatcher(instanceRoot: string, onChange: () => void, debounceMs?: number): vscode.Disposable {
  return createDebouncedFsWatcher(instanceRoot, OVERWRITE_GLOB, onChange, debounceMs);
}

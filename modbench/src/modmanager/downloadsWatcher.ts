import type * as vscode from 'vscode';
import { createDebouncedFsWatcher } from './fsWatcher';

/** A caller with its own coalescing (the Instance) passes `debounceMs` 0. */
export function createDownloadsWatcher(instanceRoot: string, onChange: () => void, debounceMs?: number): vscode.Disposable {
  return createDebouncedFsWatcher(instanceRoot, 'downloads/**', onChange, debounceMs);
}

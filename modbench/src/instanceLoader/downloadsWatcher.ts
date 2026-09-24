import type * as vscode from 'vscode';
import { createDebouncedFsWatcher } from './fsWatcher';
import { DOWNLOADS_WATCH_GLOB } from '../instanceAdapter/layout';

/** Watches the resolved downloads folder directly. `RelativePattern` takes any absolute folder
 *  as its base, workspace or not, so a folder outside the instance still watches. A caller with
 *  its own coalescing (the Instance) passes `debounceMs` 0. */
export function createDownloadsWatcher(downloadsDir: string, onChange: () => void, debounceMs?: number): vscode.Disposable {
  return createDebouncedFsWatcher(downloadsDir, DOWNLOADS_WATCH_GLOB, onChange, debounceMs);
}

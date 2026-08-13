import type * as vscode from 'vscode';
import { createDebouncedFsWatcher } from './fsWatcher';

/** Watches the instance's downloads/ folder; calls `onChange` on any create, change, or
 *  delete under it (archives or `.meta` sidecars alike — the caller just re-scans). See
 *  fsWatcher.ts for the debounce/dispose behavior shared with modsWatcher.ts and
 *  overwriteWatcher.ts. */
export function createDownloadsWatcher(instanceRoot: string, onChange: () => void): vscode.Disposable {
  return createDebouncedFsWatcher(instanceRoot, 'downloads/**', onChange);
}

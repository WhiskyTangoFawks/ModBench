import type * as vscode from 'vscode';
import { createDebouncedFsWatcher } from './fsWatcher';

// `downloadsDir` is itself the watch base — resolved by the Instance adapter, wherever it
// actually is — so the glob is everything under it, not a fixed instance-relative pattern.
const EVERYTHING = '**';

/** Watches the resolved downloads folder directly. `RelativePattern` takes any absolute folder
 *  as its base, workspace or not, so a folder outside the instance still watches. A caller with
 *  its own coalescing (the Instance) passes `debounceMs` 0. */
export function createDownloadsWatcher(downloadsDir: string, onChange: () => void, debounceMs?: number): vscode.Disposable {
  return createDebouncedFsWatcher(downloadsDir, EVERYTHING, onChange, debounceMs);
}

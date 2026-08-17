import type * as vscode from 'vscode';
import { createDebouncedFsWatcher } from './fsWatcher';

/** Watches every profile's `modlist.txt`; calls `onChange` on any create, change, or delete
 *  (#279). Installing, uninstalling and reprioritising a mod all rewrite this file, which makes it
 *  the one signal covering all three — `modsWatcher.ts` sees only what lands under `mods/`, and a
 *  reprioritise touches nothing there.
 *
 *  Every profile rather than the active one: switching profiles changes which file matters, and a
 *  watcher scoped to a path read at registration time would silently stop watching the moment it
 *  did. See fsWatcher.ts for the debounce/dispose behavior shared with the other watchers. */
export function createModlistWatcher(instanceRoot: string, onChange: () => void): vscode.Disposable {
  return createDebouncedFsWatcher(instanceRoot, 'profiles/*/modlist.txt', onChange);
}

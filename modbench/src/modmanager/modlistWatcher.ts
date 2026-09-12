import type * as vscode from 'vscode';
import { createDebouncedFsWatcher } from './fsWatcher';
import { MODLIST_GLOB } from './mo2Files';

/** Installing, uninstalling and reprioritising all rewrite this file, so it is the one signal
 *  covering all three. Every profile, not the active one: a path read at registration would
 *  stop watching the moment the profile switched. */
export function createModlistWatcher(instanceRoot: string, onChange: () => void, debounceMs?: number): vscode.Disposable {
  return createDebouncedFsWatcher(instanceRoot, MODLIST_GLOB, onChange, debounceMs);
}

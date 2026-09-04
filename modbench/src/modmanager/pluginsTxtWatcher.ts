import type * as vscode from 'vscode';
import { createDebouncedFsWatcher } from './fsWatcher';

/** Every profile, not the active one: switching profiles changes which file matters. Anything
 *  that moves the Plugin load order rewrites this file, Modbench or not (ADR-0044). */
export function createPluginsTxtWatcher(instanceRoot: string, onChange: () => void, debounceMs?: number): vscode.Disposable {
  return createDebouncedFsWatcher(instanceRoot, 'profiles/*/plugins.txt', onChange, debounceMs);
}

import type * as vscode from 'vscode';
import { createDebouncedFsWatcher } from './fsWatcher';
import { PLUGINS_GLOB } from '../instanceAdapter/layout';

/** Every profile, not the active one: switching profiles changes which file matters. Anything
 *  that moves the Plugin load order rewrites this file, Modbench or not (ADR-0013). */
export function createPluginsTxtWatcher(instanceRoot: string, onChange: () => void, debounceMs?: number): vscode.Disposable {
  return createDebouncedFsWatcher(instanceRoot, PLUGINS_GLOB, onChange, debounceMs);
}

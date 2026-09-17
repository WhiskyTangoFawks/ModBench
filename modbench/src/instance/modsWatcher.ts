import type * as vscode from 'vscode';
import { createDebouncedFsWatcher } from './fsWatcher';
import { MODS_GLOB } from '../mo2Files/layout';

/** A mod folder dropped in outside Modbench must appear without a manual refresh. Load-order
 *  callers pass `debounceMs` 0, since `loadOrderReconcile` already coalesces. */
export function createModsWatcher(instanceRoot: string, onChange: () => void, debounceMs?: number): vscode.Disposable {
  return createDebouncedFsWatcher(instanceRoot, MODS_GLOB, onChange, debounceMs);
}

import type * as vscode from 'vscode';
import { createDebouncedFsWatcher } from './fsWatcher';

/** Watches the instance's `overwrite/` folder; calls `onChange` on any create, change, or
 *  delete under it, so the Loadout's pinned Overwrite row appears the instant a purge deposits
 *  files and disappears the instant they're cleared — no manual refresh (modbench/CLAUDE.md:
 *  reactive over manual). See fsWatcher.ts for the debounce/dispose behavior shared with
 *  modsWatcher.ts. */
export function createOverwriteWatcher(instanceRoot: string, onChange: () => void): vscode.Disposable {
  return createDebouncedFsWatcher(instanceRoot, 'overwrite/**', onChange);
}

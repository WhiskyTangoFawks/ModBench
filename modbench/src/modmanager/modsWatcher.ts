import type * as vscode from 'vscode';
import { createDebouncedFsWatcher } from './fsWatcher';

/** Watches the instance's `mods/` folder; calls `onChange` on any create, change, or delete
 *  under it, so a mod folder dropped in outside Modbench (Explorer drag-in, hand-extracted
 *  archive) gets picked up the instant it appears — no manual refresh (modbench/CLAUDE.md:
 *  reactive over manual). See fsWatcher.ts for the debounce/dispose behavior shared with
 *  overwriteWatcher.ts. */
export function createModsWatcher(instanceRoot: string, onChange: () => void): vscode.Disposable {
  return createDebouncedFsWatcher(instanceRoot, 'mods/**', onChange);
}

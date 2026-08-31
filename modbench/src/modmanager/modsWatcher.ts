import type * as vscode from 'vscode';
import { createDebouncedFsWatcher } from './fsWatcher';

/** Watches the instance's `mods/` folder; calls `onChange` on any create, change, or delete
 *  under it, so a mod folder dropped in outside Modbench (Explorer drag-in, hand-extracted
 *  archive) gets picked up the instant it appears — no manual refresh (modbench/CLAUDE.md:
 *  reactive over manual). See fsWatcher.ts for the debounce/dispose behavior shared with
 *  overwriteWatcher.ts, and for `debounceMs`'s own meaning (#621's mechanism 2: the load-order
 *  use of this watcher passes 0, since `loadOrderReconcile`'s own debounce already coalesces). */
export function createModsWatcher(instanceRoot: string, onChange: () => void, debounceMs?: number): vscode.Disposable {
  return createDebouncedFsWatcher(instanceRoot, 'mods/**', onChange, debounceMs);
}

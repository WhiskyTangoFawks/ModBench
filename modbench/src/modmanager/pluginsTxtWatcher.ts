import type * as vscode from 'vscode';
import { createDebouncedFsWatcher } from './fsWatcher';

/** Watches every profile's `plugins.txt`; calls `onChange` on any create, change, or delete
 *  (ADR-0044). A reorder, an enable/disable, MO2's own refresh after an install — anything that
 *  moves the Plugin load order — rewrites this file, so it is the one signal that covers every
 *  gesture on that axis, whether Modbench wrote it or something else did (root CLAUDE.md:
 *  never assume exclusive ownership of a file on disk).
 *
 *  Every profile rather than the active one, for the reason `modlistWatcher.ts` gives: switching
 *  profiles changes which file matters. See fsWatcher.ts for the shared debounce/dispose behavior. */
export function createPluginsTxtWatcher(instanceRoot: string, onChange: () => void): vscode.Disposable {
  return createDebouncedFsWatcher(instanceRoot, 'profiles/*/plugins.txt', onChange);
}

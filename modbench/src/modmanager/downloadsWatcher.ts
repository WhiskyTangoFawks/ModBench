import type * as vscode from 'vscode';
import { createDebouncedFsWatcher } from './fsWatcher';

export function createDownloadsWatcher(instanceRoot: string, onChange: () => void): vscode.Disposable {
  return createDebouncedFsWatcher(instanceRoot, 'downloads/**', onChange);
}

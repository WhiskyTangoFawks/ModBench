// A watch through VS Code's file watcher, as every implementation of the Instance adapter arms one.

import * as vscode from 'vscode';
import type { HeldFolderWatch } from './heldFolders';
import type { Subscription } from './instanceAdapter';

/** Each change beneath `base` that matches `glob`, created, changed or deleted alike; `changed` when VS Code reported it as one. */
export function watchFiles(base: string, glob: string, onChange: (path: string, changed: boolean) => void, held?: HeldFolderWatch): Subscription {
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(base), glob));
  void held?.open();
  const madeAnew = (changed: boolean) => (uri: vscode.Uri): void => {
    onChange(uri.fsPath, changed);
    void held?.created(uri.fsPath);
  };
  watcher.onDidCreate(madeAnew(false));
  // VS Code reports a folder deleted and made again in one burst as changed.
  watcher.onDidChange(madeAnew(true));
  watcher.onDidDelete((uri) => {
    onChange(uri.fsPath, false);
    held?.removed(uri.fsPath);
  });
  return {
    dispose: () => {
      watcher.dispose();
      held?.close();
    },
  };
}

// A watch through VS Code's file watcher, as every implementation of the Instance adapter arms one.

import * as vscode from 'vscode';
import type { HeldFolderWatch } from './heldFolders';
import type { Subscription } from './instanceAdapter';

/** Each change beneath `base` that matches `glob`, created, changed or deleted alike. */
export function watchFiles(base: string, glob: string, onChange: (path: string) => void, held?: HeldFolderWatch): Subscription {
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(base), glob));
  void held?.open();
  const heard = (uri: vscode.Uri): void => onChange(uri.fsPath);
  const madeAnew = (uri: vscode.Uri): void => {
    heard(uri);
    void held?.created(uri.fsPath);
  };
  watcher.onDidCreate(madeAnew);
  // VS Code reports a folder deleted and made again in one burst as changed.
  watcher.onDidChange(madeAnew);
  watcher.onDidDelete((uri) => {
    heard(uri);
    held?.removed(uri.fsPath);
  });
  return {
    dispose: () => {
      watcher.dispose();
      held?.close();
    },
  };
}

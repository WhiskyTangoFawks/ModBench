// The host's file watcher, which the Instance adapter arms for each folder it watches: VS Code
// already watches files on every platform, so the adapter asks it rather than the OS.

import * as vscode from 'vscode';
import type { WatchFiles } from './instanceAdapter/mo2Watch';

export const watchFilesInHost: WatchFiles = (base, glob, onChange) => {
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(base), glob));
  const heard = (uri: vscode.Uri): void => onChange(uri.fsPath);
  watcher.onDidCreate(heard);
  watcher.onDidChange(heard);
  watcher.onDidDelete(heard);
  return watcher;
};

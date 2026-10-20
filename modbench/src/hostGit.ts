import * as vscode from 'vscode';
import type { HostGit } from './ports/repository';

interface GitExtensionExports {
  getAPI(version: 1): { init(folder: vscode.Uri): Thenable<unknown> };
}

export const hostGit: HostGit<vscode.Uri> = {
  extension: () => vscode.extensions.getExtension<GitExtensionExports>('vscode.git'),
  folderOf: (path) => vscode.Uri.file(path),
};

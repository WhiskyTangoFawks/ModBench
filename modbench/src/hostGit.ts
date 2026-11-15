import * as vscode from 'vscode';
import type { HostGit, HostGitApi } from './ports/repository';

export const hostGit: HostGit<vscode.Uri> = {
  extension: () => vscode.extensions.getExtension<{ getAPI(version: 1): HostGitApi<vscode.Uri> }>('vscode.git'),
  folderOf: (path) => vscode.Uri.file(path),
  pathOf: (folder) => folder.fsPath,
};

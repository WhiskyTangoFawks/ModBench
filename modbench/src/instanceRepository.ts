import * as vscode from 'vscode';
import type { GitExtensionExports, HostGit } from './ports/repository';

export const hostGit: HostGit = {
  extension: () => vscode.extensions.getExtension<GitExtensionExports>('vscode.git'),
  folderUri: (folder) => vscode.Uri.file(folder),
};

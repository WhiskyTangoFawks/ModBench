import * as vscode from 'vscode';

/** The folders of the workspace on disk. */
export const workspaceRoots = (): string[] => (vscode.workspace.workspaceFolders ?? []).filter(({ uri }) => uri.scheme === 'file').map(({ uri }) => uri.fsPath);

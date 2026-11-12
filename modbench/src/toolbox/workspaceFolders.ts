import * as vscode from 'vscode';
import { isInside } from '../ports/pathInside';

export const openRoots = (): string[] => (vscode.workspace.workspaceFolders ?? []).filter(({ uri }) => uri.scheme === 'file').map(({ uri }) => uri.fsPath);

export const workspaceFolders = {
  holds: (path: string): boolean => openRoots().some((root) => isInside(path, root, process.platform)),
  onDidChange: (listener: () => void): vscode.Disposable => vscode.workspace.onDidChangeWorkspaceFolders(listener),
};

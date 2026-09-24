import * as vscode from 'vscode';
import type { MoveToTrash } from './ports/trash';

export const moveToTrash: MoveToTrash = async (path) => {
  await vscode.workspace.fs.delete(vscode.Uri.file(path), { useTrash: true });
};

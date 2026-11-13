import * as vscode from 'vscode';
import { ambientWrites } from './instanceLoader/ambientWrites';
import type { MoveToTrash } from './ports/trash';

export const moveToTrash: MoveToTrash = async (path) => {
  ambientWrites.name([path]);
  await vscode.workspace.fs.delete(vscode.Uri.file(path), { recursive: true, useTrash: true });
};

import * as vscode from 'vscode';
import { nameWrites } from './ports/writeNaming';
import type { MoveToTrash } from './ports/trash';

export const moveToTrash: MoveToTrash = async (path) => {
  nameWrites(path);
  await vscode.workspace.fs.delete(vscode.Uri.file(path), { recursive: true, useTrash: true });
};

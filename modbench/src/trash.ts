import * as vscode from 'vscode';
import { toldAfter } from './repositoriesLib/writesTold';
import type { MoveToTrash } from './ports/trash';

export const moveToTrash: MoveToTrash = (path) =>
  toldAfter([path], () => Promise.resolve(vscode.workspace.fs.delete(vscode.Uri.file(path), { recursive: true, useTrash: true })));

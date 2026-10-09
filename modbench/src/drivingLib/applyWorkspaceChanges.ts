import * as vscode from 'vscode';

/** A file or folder a change moves. */
export interface FileMove { from: vscode.Uri; to: vscode.Uri }

/** Changes by absolute path: each move, then each deletion of a file or folder, then each document's text once moved. */
export interface WorkspaceChanges {
  moves: readonly { from: string; to: string }[];
  deletions: readonly string[];
  documents: readonly { path: string; text: string }[];
}

const within = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`) || path.startsWith(`${folder}\\`);

/** Applies the changes as one workspace edit, a refactoring: VS Code saves as it does for any other. A document keeps its last text; one a later item deletes is not written. `moving` answers its undo. */
export async function applyWorkspaceChanges(
  items: readonly WorkspaceChanges[],
  options: { read?: vscode.Uri; moving?: (moves: readonly FileMove[]) => () => void } = {},
): Promise<void> {
  const lastWriter = new Map<string, number>();
  items.forEach(({ documents }, index) => { for (const { path } of documents) lastWriter.set(path, index); });
  const deletedLater = (path: string, index: number) =>
    items.slice(index + 1).some(({ deletions }) => deletions.some((deleted) => within(path, deleted)));

  const changes = new vscode.WorkspaceEdit();
  const moves: FileMove[] = [];
  items.forEach((item, index) => {
    for (const { from, to } of item.moves) {
      const move = { from: vscode.Uri.file(from), to: vscode.Uri.file(to) };
      moves.push(move);
      changes.renameFile(move.from, move.to);
    }
    for (const path of item.deletions) changes.deleteFile(vscode.Uri.file(path), { recursive: true, ignoreIfNotExists: true });
    for (const { path, text } of item.documents) {
      if (lastWriter.get(path) !== index || deletedLater(path, index)) continue;
      const uri = documentAt(path, options.read);
      changes.createFile(uri, { ignoreIfExists: true });
      changes.replace(uri, new vscode.Range(0, 0, Number.MAX_SAFE_INTEGER, 0), text);
    }
  });

  const notMoving = options.moving?.(moves);
  let applied = false;
  try {
    applied = await vscode.workspace.applyEdit(changes, { isRefactoring: true });
  } finally {
    if (!applied) notMoving?.();
  }
  if (!applied) throw new Error('VS Code did not apply the changes.');
}

function documentAt(path: string, read: vscode.Uri | undefined): vscode.Uri {
  const file = vscode.Uri.file(path);
  return file.path === read?.path ? read : file;
}

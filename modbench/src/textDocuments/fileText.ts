import * as vscode from 'vscode';

/** A file's text, decoded so it yields no plugin's bytes (ADR-0004): refusing what is not text, and
 *  keeping a byte order mark. */
export async function fileText(uri: vscode.Uri): Promise<string> {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await vscode.workspace.fs.readFile(uri));
}

/** A file's text as VS Code shows it: its document's when one is open, else the file on disk, and no document is
 *  opened. A file that is gone has none. */
export async function heldOrSavedText(path: string): Promise<string> {
  const open = vscode.workspace.textDocuments.find((document) => document.uri.scheme === 'file' && document.uri.fsPath === path);
  return open ? open.getText() : await savedText(vscode.Uri.file(path)) ?? '';
}

/** The file on disk, as VS Code misses a write to a file outside the workspace while its tab is
 *  hidden. A document's text has no byte order mark. */
export async function savedText(uri: vscode.Uri): Promise<string | undefined> {
  try {
    return (await fileText(uri)).replace(/^\uFEFF/, '');
  } catch (err) {
    if (err instanceof vscode.FileSystemError && err.code === 'FileNotFound') return undefined;
    throw err;
  }
}

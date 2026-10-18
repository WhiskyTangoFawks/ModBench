import * as vscode from 'vscode';

/** A file's text, decoded so it yields no plugin's bytes (ADR-0004): refusing what is not text, and
 *  keeping a byte order mark. */
export async function fileText(uri: vscode.Uri): Promise<string> {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await vscode.workspace.fs.readFile(uri));
}

/** The file on disk, as VS Code misses a write to a file outside the workspace while its tab is
 *  hidden. A document's text has no byte order mark. A file gone is undefined. */
export async function savedText(uri: vscode.Uri): Promise<string | undefined> {
  try {
    return (await fileText(uri)).replace(/^\uFEFF/, '');
  } catch (err) {
    if (err instanceof vscode.FileSystemError && err.code === 'FileNotFound') return undefined;
    throw err;
  }
}

import * as vscode from 'vscode';

/** A file's text, decoded so it yields no plugin's bytes (ADR-0004): refusing what is not text, and
 *  keeping a byte order mark. */
export async function fileText(uri: vscode.Uri): Promise<string> {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await vscode.workspace.fs.readFile(uri));
}

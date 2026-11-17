import * as vscode from 'vscode';
import type { MEditClient } from '../client';
import { heldText, isUnsaved } from '../textDocuments/heldText';
import { isPluginSourceDocument, type IsPluginSource } from '../textDocuments/pluginSource';

/** Hands mEdit a plugin-source document as it becomes unsaved, as its text changes and as a save, a revert or a close
 *  ends it. A file's document and its child records' hold one text. */
export function handUnsavedPluginSource(client: Pick<MEditClient, 'handUnsavedDocument'>, isPluginSource: IsPluginSource): vscode.Disposable {
  const handed = new Map<string, string>();
  let version = 0;
  const unsavedTextOf = (path: string, closing?: vscode.TextDocument): string | undefined => {
    const holder = vscode.workspace.textDocuments.find((document) =>
      document !== closing && document.uri.fsPath === path && isUnsaved(document) && isPluginSourceDocument(document.uri, isPluginSource));
    return holder && heldText(holder);
  };
  const hand = (document: vscode.TextDocument, closing?: vscode.TextDocument) => {
    if (!isPluginSourceDocument(document.uri, isPluginSource)) return;
    const path = document.uri.fsPath;
    const text = unsavedTextOf(path, closing);
    if (text === handed.get(path)) return;
    if (text === undefined) {
      handed.delete(path);
      client.handUnsavedDocument({ path, closed: true });
    } else {
      handed.set(path, text);
      client.handUnsavedDocument({ path, text, version: ++version });
    }
  };
  vscode.workspace.textDocuments.forEach((document) => { hand(document); });
  return vscode.Disposable.from(
    vscode.workspace.onDidOpenTextDocument((document) => { hand(document); }),
    vscode.workspace.onDidChangeTextDocument(({ document }) => { hand(document); }),
    vscode.workspace.onDidSaveTextDocument((document) => { hand(document); }),
    vscode.workspace.onDidCloseTextDocument((document) => { hand(document, document); }),
  );
}

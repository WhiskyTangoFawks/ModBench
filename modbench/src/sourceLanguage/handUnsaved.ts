import * as vscode from 'vscode';
import type { MEditClient } from '../client';
import { dirtyPluginSource } from './dirtyPluginSource';

/** Hands mEdit the unsaved plugin source now, and again whenever a document changes, opens or closes: a
 *  save, a revert, a close without saving and a move each end or begin a dirty document. */
export function handUnsavedPluginSource(client: Pick<MEditClient, 'handUnsavedDocuments'>): vscode.Disposable {
  const changedAt = new Map<string, number>();
  let changes = 0;
  const hand = () => { client.handUnsavedDocuments(dirtyPluginSource((uri) => changedAt.get(uri.toString()) ?? 0)); };
  hand();
  return vscode.Disposable.from(
    vscode.workspace.onDidChangeTextDocument(({ document }) => {
      changedAt.set(document.uri.toString(), ++changes);
      hand();
    }),
    vscode.workspace.onDidOpenTextDocument(hand),
    vscode.workspace.onDidCloseTextDocument(hand),
  );
}

import * as vscode from 'vscode';
import type { MEditClient } from '../client';
import { dirtyPluginSource, isPluginSourceDocument } from './dirtyPluginSource';

/** Hands mEdit the unsaved plugin source now, and again whenever a document changes, opens or closes: a
 *  save, a revert, a close without saving and a move each end or begin a dirty document. */
export function handUnsavedPluginSource(client: Pick<MEditClient, 'handUnsavedDocuments'>): vscode.Disposable {
  const hand = () => { client.handUnsavedDocuments(dirtyPluginSource()); };
  const handFor = ({ uri }: vscode.TextDocument) => { if (isPluginSourceDocument(uri)) hand(); };
  hand();
  return vscode.Disposable.from(
    vscode.workspace.onDidChangeTextDocument(({ document }) => { handFor(document); }),
    vscode.workspace.onDidOpenTextDocument(handFor),
    vscode.workspace.onDidCloseTextDocument(handFor),
  );
}

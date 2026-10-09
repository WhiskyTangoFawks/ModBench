import * as vscode from 'vscode';
import type { MEditClient } from '../client';
import { isPluginSourcePath } from '../instanceAdapter/instanceAdapter';
import { dirtyPluginSource } from './dirtyPluginSource';

/** Hands mEdit the unsaved plugin source now, and again on each change to a plugin-source document, its
 *  dirty state included, so a save or a revert hands it over too. */
export function handUnsavedPluginSource(client: Pick<MEditClient, 'handUnsavedDocuments'>): vscode.Disposable {
  client.handUnsavedDocuments(dirtyPluginSource());
  return vscode.workspace.onDidChangeTextDocument(({ document: { uri } }) => {
    if (uri.scheme === 'file' && isPluginSourcePath(uri.fsPath)) client.handUnsavedDocuments(dirtyPluginSource());
  });
}

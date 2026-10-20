import * as vscode from 'vscode';
import { CONTAINER_SCHEMES } from './recordDocument';
import { heldText, isUnsaved } from './heldText';

export type IsPluginSource = (path: string) => boolean;

export const isPluginSourceDocument = ({ scheme, fsPath }: vscode.Uri, isPluginSource: IsPluginSource): boolean =>
  CONTAINER_SCHEMES.has(scheme) && isPluginSource(fsPath);

export const openPluginSourceDocument = (uri: vscode.Uri): Thenable<vscode.TextDocument> => vscode.workspace.openTextDocument(uri);

export const readHeldText = async (file: string): Promise<string> => heldText(await openPluginSourceDocument(vscode.Uri.file(file)));

/** A child record's document holds its container's whole text, the one its file's document holds. */
export function unsavedPluginSource(isPluginSource: IsPluginSource): { path: string; text: string }[] {
  const held = new Map<string, string>();
  for (const document of vscode.workspace.textDocuments) {
    if (isUnsaved(document) && isPluginSourceDocument(document.uri, isPluginSource)) held.set(document.uri.fsPath, heldText(document));
  }
  return [...held].map(([path, text]) => ({ path, text }));
}

/** A save, a revert, a close without saving and a move each end or begin an unsaved document. */
export function onPluginSourceChanged(isPluginSource: IsPluginSource, changed: () => void): vscode.Disposable {
  const changedFor = ({ uri }: vscode.TextDocument) => { if (isPluginSourceDocument(uri, isPluginSource)) changed(); };
  return vscode.Disposable.from(
    vscode.workspace.onDidChangeTextDocument(({ document }) => { changedFor(document); }),
    vscode.workspace.onDidOpenTextDocument(changedFor),
    vscode.workspace.onDidCloseTextDocument(changedFor),
  );
}

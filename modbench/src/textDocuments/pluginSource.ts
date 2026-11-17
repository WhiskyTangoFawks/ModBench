import * as vscode from 'vscode';
import { CONTAINER_SCHEMES } from './recordDocument';

export type IsPluginSource = (path: string) => boolean;

export const isPluginSourceDocument = ({ scheme, fsPath }: vscode.Uri, isPluginSource: IsPluginSource): boolean =>
  CONTAINER_SCHEMES.has(scheme) && isPluginSource(fsPath);

export const openPluginSourceDocument = (uri: vscode.Uri): Thenable<vscode.TextDocument> => vscode.workspace.openTextDocument(uri);

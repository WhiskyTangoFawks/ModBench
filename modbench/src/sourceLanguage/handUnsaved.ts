import type * as vscode from 'vscode';
import type { MEditClient } from '../client';
import { onPluginSourceChanged, unsavedPluginSource, type IsPluginSource } from '../textDocuments/pluginSource';

export function handUnsavedPluginSource(client: Pick<MEditClient, 'handUnsavedDocuments'>, isPluginSource: IsPluginSource): vscode.Disposable {
  const hand = () => { client.handUnsavedDocuments(unsavedPluginSource(isPluginSource)); };
  hand();
  return onPluginSourceChanged(isPluginSource, hand);
}

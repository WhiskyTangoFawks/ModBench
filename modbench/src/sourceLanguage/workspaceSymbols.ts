import type * as vscode from 'vscode';
import type { MEditClient, PluginMetadata, RecordSummary } from '../client';
import { errorMessage } from '../ports/errorMessage';
import type { Reporter } from '../ports/reporter';
import { pluginAddressOf } from '../wire/pluginAddress';
import { copyDocument, type RecordCopy } from '../drivingLib/recordDocument';
import { recordLabel } from './formKeyHover';
import { formKeyMember } from './formKeyDefinition';
import type { RecordLocation, RecordLocationDeps } from './recordLocation';

export interface WorkspaceSymbolDeps<Document> extends RecordLocationDeps<Document> {
  client: RecordLocationDeps<Document>['client'] & Pick<MEditClient, 'getPlugins' | 'searchRecords'>;
  reporter: Pick<Reporter, 'report'>;
}

export interface RecordSymbol extends RecordCopy { name: string; uri: vscode.Uri }

const GESTURE = 'Go to Symbol in Workspace';

export function workspaceSymbolsOf<Document extends { getText(): string }>({ client, reporter, open }: WorkspaceSymbolDeps<Document>) {
  const searched = async (query: string, plugin: PluginMetadata): Promise<RecordSummary[] | string> => {
    try {
      return (await client.searchRecords(query, [], plugin)).items;
    } catch (error) {
      return `${plugin.name} (${plugin.origin}): ${errorMessage(error)}`;
    }
  };
  const located = async (found: RecordSummary): Promise<RecordSymbol | string> => {
    const copy = { formKey: found.formKey, plugin: pluginAddressOf(found) };
    try {
      const opened = await copyDocument(client, copy);
      if ('refused' in opened) return opened.refused;
      return { ...copy, name: recordLabel(found.editorId, found.formKey), uri: opened.uri };
    } catch (error) {
      return `${copy.formKey} in ${copy.plugin.name} (${copy.plugin.origin}): ${errorMessage(error)}`;
    }
  };
  const symbolsFor = async (query: string): Promise<RecordSymbol[]> => {
    let plugins: PluginMetadata[];
    try {
      plugins = await client.getPlugins();
    } catch (error) {
      reporter.report('error', `${GESTURE} cannot list the tracked plugins.`, errorMessage(error));
      return [];
    }
    const pages = await Promise.all(plugins.filter((plugin) => plugin.isTracked && plugin.inLoadOrder)
      .map((plugin) => searched(query, plugin)));
    const symbols = await Promise.all(pages.flatMap((page) => typeof page === 'string' ? [] : page).map(located));
    const leftOut = [...pages, ...symbols].filter((result) => typeof result === 'string');
    if (leftOut.length > 0) {
      reporter.report('warning', `${GESTURE} on "${query}" left out what it could not search or open.`, leftOut.join(' '));
    }
    return symbols.filter((symbol) => typeof symbol !== 'string');
  };
  const locate = async ({ name, formKey, uri }: RecordSymbol): Promise<RecordLocation<Document> | undefined> => {
    try {
      const document = await open(uri);
      const member = formKeyMember(document.getText(), formKey);
      return member && { uri, document, ...member };
    } catch (error) {
      reporter.report('error', `${GESTURE} cannot open ${name}.`, errorMessage(error));
      return undefined;
    }
  };
  return { symbolsFor, locate };
}

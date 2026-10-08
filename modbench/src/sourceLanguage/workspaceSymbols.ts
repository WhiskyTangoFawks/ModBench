import type * as vscode from 'vscode';
import type { MEditClient, PluginMetadata, RecordSummary } from '../client';
import { errorMessage } from '../ports/errorMessage';
import type { Reporter } from '../ports/reporter';
import { pluginAddressOf } from '../wire/pluginAddress';
import type { RecordCopy } from '../drivingLib/recordDocument';
import { locateCopies, type RecordLocation, type RecordLocationDeps } from './recordLocation';
import { formKeyMember, recordLabel } from './sourceText';

interface WorkspaceSymbolDeps<Document> extends RecordLocationDeps<Document> {
  client: RecordLocationDeps<Document>['client'] & Pick<MEditClient, 'getPlugins' | 'searchRecords'>;
  reporter: Pick<Reporter, 'shownOnSurface'>;
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
  const symbolsFor = async (query: string): Promise<RecordSymbol[]> => {
    if (!query.trim()) return [];
    let plugins: PluginMetadata[];
    try {
      plugins = await client.getPlugins();
    } catch (error) {
      reporter.shownOnSurface('error', `${GESTURE} cannot list the tracked plugins.`, errorMessage(error));
      return [];
    }
    const pages = await Promise.all(plugins.filter((plugin) => plugin.isTracked)
      .map((plugin) => searched(query, plugin)));
    const copies = pages.flatMap((page) => typeof page === 'string' ? [] : page)
      .map((row) => ({ formKey: row.formKey, plugin: pluginAddressOf(row), name: recordLabel(row.editorId, row.formKey) }));
    const { found, leftOut } = await locateCopies(client, copies, (copy, uri): RecordSymbol => ({ ...copy, uri }));
    for (const why of [...pages.filter((page) => typeof page === 'string'), ...leftOut]) {
      reporter.shownOnSurface('warning', `${GESTURE} left out what it could not search or open.`, why);
    }
    return found;
  };
  const locate = async ({ name, formKey, uri }: RecordSymbol): Promise<RecordLocation<Document> | undefined> => {
    try {
      const document = await open(uri);
      const member = formKeyMember(document.getText(), formKey);
      if (!member) {
        reporter.shownOnSurface('warning', `${GESTURE} cannot open ${name}.`, `${uri.path} states no ${formKey} member.`);
        return undefined;
      }
      return { uri, document, ...member };
    } catch (error) {
      reporter.shownOnSurface('error', `${GESTURE} cannot open ${name}.`, errorMessage(error));
      return undefined;
    }
  };
  return { symbolsFor, locate };
}

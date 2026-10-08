import type * as vscode from 'vscode';
import type { MEditClient, PluginMetadata, RecordSummary } from '../client';
import { errorMessage } from '../ports/errorMessage';
import type { Reporter, Severity } from '../ports/reporter';
import { pluginAddressOf } from '../wire/pluginAddress';
import type { RecordCopy } from '../drivingLib/recordDocument';
import { locateCopies, type RecordLocation, type RecordLocationDeps } from './recordLocation';
import { formKeyMember, recordLabel } from './sourceText';

interface WorkspaceSymbolDeps<Document> extends RecordLocationDeps<Document> {
  client: RecordLocationDeps<Document>['client'] & Pick<MEditClient, 'getPlugins' | 'searchRecords'>;
  reporter: Pick<Reporter, 'report'>;
}

export interface RecordSymbol extends RecordCopy { name: string; uri: vscode.Uri }

const GESTURE = 'Go to Symbol in Workspace';

/** A search runs at each pause in typing, so a reason is told once, until it changes or a search
 *  leaves nothing out (ADR-0019: a toast the user learns to dismiss recreates silence). */
export function workspaceSymbolsOf<Document extends { getText(): string }>({ client, reporter, open }: WorkspaceSymbolDeps<Document>) {
  let told: string | undefined;
  const tell = (severity: Severity, message: string, detail: string) => {
    const reason = JSON.stringify([message, detail]);
    if (reason === told) return;
    told = reason;
    reporter.report(severity, message, detail);
  };
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
      tell('error', `${GESTURE} cannot list the tracked plugins.`, errorMessage(error));
      return [];
    }
    const pages = await Promise.all(plugins.filter((plugin) => plugin.isTracked && plugin.inLoadOrder)
      .map((plugin) => searched(query, plugin)));
    const copies = pages.flatMap((page) => typeof page === 'string' ? [] : page)
      .map((row) => ({ formKey: row.formKey, plugin: pluginAddressOf(row), name: recordLabel(row.editorId, row.formKey) }));
    const { found, leftOut } = await locateCopies(client, copies, (copy, uri): RecordSymbol => ({ ...copy, uri }));
    const unsearched = pages.filter((page) => typeof page === 'string');
    if (unsearched.length + leftOut.length === 0) told = undefined;
    else tell('warning', `${GESTURE} left out what it could not search or open.`, [...unsearched, ...leftOut].join(' '));
    return found;
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

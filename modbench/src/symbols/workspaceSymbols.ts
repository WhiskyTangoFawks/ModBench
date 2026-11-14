import type * as vscode from 'vscode';
import type { MEditClient, PluginMetadata, RecordPage } from '../client';
import { errorMessage } from '../ports/errorMessage';
import type { Reporter } from '../ports/reporter';
import { pluginAddressOf } from '../wire/pluginAddress';
import type { RecordCopy } from '../wire/recordCopy';
import { heldText } from '../textDocuments/heldText';
import { locateCopies, type RecordLocation, type RecordLocationDeps } from './recordLocation';
import { recordLabel } from '../wire/recordLabel';
import { answerOf } from '../wire/readFailed';
import type { SourceNames } from './sourceNames';

interface WorkspaceSymbolDeps<Document> extends RecordLocationDeps<Document> {
  client: RecordLocationDeps<Document>['client'] & Pick<MEditClient, 'getPlugins' | 'searchRecords'>;
  reporter: Pick<Reporter, 'shownOnSurface'>;
  declarationIn: SourceNames['declarationIn'];
}

export interface RecordSymbol extends RecordCopy { name: string; uri: vscode.Uri }

const GESTURE = 'Go to Symbol in Workspace';

export function workspaceSymbolsOf<Document extends { getText(): string }>({ client, reporter, open, declarationIn }: WorkspaceSymbolDeps<Document>) {
  // mEdit searches every active plugin in one ask, and a plugin outside the load order only when given it.
  const searched = async (query: string, plugin?: PluginMetadata): Promise<RecordPage | string> => {
    try {
      return answerOf(await client.searchRecords(query, [], plugin));
    } catch (error) {
      return `${plugin ? `${plugin.name} (${plugin.origin})` : 'The active plugins'}: ${errorMessage(error)}`;
    }
  };
  /** Each copy, in an active or a compiled plugin, of a record whose EditorID or FormKey holds `query`; `gesture` names
   *  what the user ran in what the Output says. */
  const symbolsFor = async (query: string, gesture: string): Promise<RecordSymbol[]> => {
    let plugins: PluginMetadata[];
    try {
      plugins = answerOf(await client.getPlugins());
    } catch (error) {
      reporter.shownOnSurface('error', `${gesture} cannot list the compiled plugins.`, errorMessage(error));
      return [];
    }
    const outsideTheLoadOrder = plugins.filter((plugin) => plugin.isCompiledPlugin && !plugin.inLoadOrder);
    const searches = await Promise.all([searched(query), ...outsideTheLoadOrder.map((plugin) => searched(query, plugin))]);
    const pages = searches.filter((page) => typeof page !== 'string');
    const items = pages.flatMap((page) => page.items);
    const total = pages.reduce((sum, page) => sum + page.total, 0);
    if (items.length < total) {
      reporter.shownOnSurface('warning', `${gesture} lists ${items.length} of the ${total} copies of records whose EditorID or FormKey holds "${query}".`,
        'Type more of the EditorID or FormKey to narrow the list.');
    }
    const copies = items.map((row) => ({ formKey: row.formKey, plugin: pluginAddressOf(row), name: recordLabel(row.editorId, row.formKey) }));
    const { found, leftOut } = await locateCopies(client, copies, (copy, uri): RecordSymbol => ({ ...copy, uri }));
    for (const why of [...searches.filter((page) => typeof page === 'string'), ...leftOut]) {
      reporter.shownOnSurface('warning', `${gesture} left out what it could not search or open.`, why);
    }
    return found;
  };
  const locate = async ({ name, formKey, uri }: RecordSymbol): Promise<RecordLocation<Document> | undefined> => {
    try {
      const document = await open(uri);
      const member = await declarationIn(heldText(document), formKey);
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

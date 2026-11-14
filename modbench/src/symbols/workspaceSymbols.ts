import type * as vscode from 'vscode';
import type { MEditClient, PluginMetadata, RecordPage, RecordSummary } from '../client';
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

// VS Code asks again at each keystroke, and each copy listed asks mEdit for its document: a search lists no more copies
// than a person reads down, since typing more narrows it.
const MOST_COPIES_LISTED = 200;

// A FormKey names one record, which every copy mEdit answers for it shares: typing more cannot narrow the list.
const namesOneRecord = (query: string, items: readonly RecordSummary[]): boolean =>
  items.every(({ formKey }) => formKey.toLowerCase() === query.toLowerCase());

export function workspaceSymbolsOf<Document extends { getText(): string }>({ client, reporter, open, declarationIn }: WorkspaceSymbolDeps<Document>) {
  // mEdit searches every active plugin in one ask, and a plugin outside the load order only when given it.
  const searched = async (query: string, plugin?: PluginMetadata): Promise<RecordPage | string> => {
    try {
      return answerOf(await client.searchRecords(query, [], plugin, MOST_COPIES_LISTED));
    } catch (error) {
      return `${plugin ? `${plugin.name} (${plugin.origin})` : 'The active plugins'}: ${errorMessage(error)}`;
    }
  };
  const compiledOutsideTheLoadOrder = async (gesture: string): Promise<PluginMetadata[] | undefined> => {
    try {
      return answerOf(await client.getPlugins()).filter((plugin) => plugin.isCompiledPlugin && !plugin.inLoadOrder);
    } catch (error) {
      reporter.shownOnSurface('error', `${gesture} cannot list the compiled plugins.`, errorMessage(error));
      return undefined;
    }
  };
  const located = async (searches: readonly (RecordPage | string)[], gesture: string, kept: (row: RecordSummary) => boolean = () => true) => {
    const copies = searches.flatMap((page) => typeof page === 'string' ? [] : page.items).filter(kept)
      .map((row) => ({ formKey: row.formKey, plugin: pluginAddressOf(row), name: recordLabel(row.editorId, row.formKey) }));
    const { found, leftOut } = await locateCopies(client, copies, (copy, uri): RecordSymbol => ({ ...copy, uri }));
    for (const why of [...searches.filter((page) => typeof page === 'string'), ...leftOut]) {
      reporter.shownOnSurface('warning', `${gesture} left out what it could not search or open.`, why);
    }
    return found;
  };

  /** Each copy, in an active or a compiled plugin, of a record whose EditorID or FormKey holds `query`; `gesture` names
   *  what the user ran in what the Output says, with how many it lists of how many match. */
  const symbolsFor = async (query: string, gesture: string): Promise<RecordSymbol[]> => {
    const outside = await compiledOutsideTheLoadOrder(gesture);
    if (outside === undefined) return [];
    const searches = await Promise.all([searched(query), ...outside.map((plugin) => searched(query, plugin))]);
    const pages = searches.filter((page) => typeof page !== 'string');
    const items = pages.flatMap((page) => page.items);
    const total = pages.reduce((sum, page) => sum + page.total, 0);
    if (items.length < total) {
      reporter.shownOnSurface('warning', `${gesture} lists ${items.length} of the ${total} copies of records whose EditorID or FormKey holds "${query}".`,
        namesOneRecord(query, items) ? undefined : 'Type more of the EditorID or FormKey to narrow the list.');
    }
    return located(searches, gesture);
  };

  /** Each copy of `formKey` in a compiled plugin outside the load order. */
  const compiledCopiesOf = async (formKey: string, gesture: string): Promise<RecordSymbol[]> => {
    const outside = await compiledOutsideTheLoadOrder(gesture);
    if (outside === undefined) return [];
    return located(await Promise.all(outside.map((plugin) => searched(formKey, plugin))), gesture, (row) => row.formKey === formKey);
  };

  /** Where the copy `gesture` lists opens: its FormKey member in its document. */
  const locate = async ({ name, formKey, uri }: RecordSymbol, gesture: string): Promise<RecordLocation<Document> | undefined> => {
    try {
      const document = await open(uri);
      const member = await declarationIn(heldText(document), formKey);
      if (!member) {
        reporter.shownOnSurface('warning', `${gesture} cannot open ${name}.`, `${uri.path} states no ${formKey} member.`);
        return undefined;
      }
      return { uri, document, ...member };
    } catch (error) {
      reporter.shownOnSurface('error', `${gesture} cannot open ${name}.`, errorMessage(error));
      return undefined;
    }
  };
  return { symbolsFor, compiledCopiesOf, locate };
}

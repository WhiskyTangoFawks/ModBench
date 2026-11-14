import type { MEditClient, PluginMetadata, RecordPage, RecordSummary } from '../client';
import { errorMessage } from '../ports/errorMessage';
import type { Reporter } from '../ports/reporter';
import { pluginAddressOf, samePluginAddress } from '../wire/pluginAddress';
import type { RecordCopy } from '../wire/recordCopy';
import { locateRecord, type RecordLocation, type RecordLocationDeps } from './recordLocation';
import { recordLabel } from '../wire/recordLabel';
import { answerOf } from '../wire/readFailed';
import type { SourceNames } from './sourceNames';
import type { SymbolSearch } from './symbolKind';

interface WorkspaceSymbolDeps<Document> extends RecordLocationDeps<Document> {
  client: RecordLocationDeps<Document>['client'] & Pick<MEditClient, 'getPlugins' | 'searchRecords'>;
  reporter: Pick<Reporter, 'shownOnSurface'>;
  declarationIn: SourceNames['declarationIn'];
}

/** A copy a search finds, with its plugin's file, which places it until the user picks it. */
export interface RecordSymbol extends RecordCopy { name: string; pluginFile: string }

// VS Code asks again at each keystroke, and a listing asks mEdit only to search: a search lists no more copies than a
// person reads down, since typing more narrows it.
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
  const pluginsListed = async (gesture: string): Promise<PluginMetadata[] | undefined> => {
    try {
      return answerOf(await client.getPlugins());
    } catch (error) {
      reporter.shownOnSurface('error', `${gesture} cannot list the compiled plugins.`, errorMessage(error));
      return undefined;
    }
  };
  const compiledOutsideTheLoadOrder = (plugins: readonly PluginMetadata[]) => plugins.filter((plugin) => plugin.isCompiledPlugin && !plugin.inLoadOrder);
  const listed = (plugins: readonly PluginMetadata[], searches: readonly (RecordPage | string)[], gesture: string, kept: (row: RecordSummary) => boolean = () => true) => {
    const found: RecordSymbol[] = [];
    const leftOut = searches.filter((page) => typeof page === 'string');
    for (const row of searches.flatMap((page) => typeof page === 'string' ? [] : page.items).filter(kept)) {
      const plugin = pluginAddressOf(row);
      const file = plugins.find((each) => samePluginAddress(each, plugin))?.path;
      if (file === undefined) leftOut.push(`mEdit lists no plugin ${plugin.name} (${plugin.origin}), which holds ${row.formKey}.`);
      else found.push({ formKey: row.formKey, plugin, name: recordLabel(row.editorId, row.formKey), pluginFile: file });
    }
    for (const why of leftOut) reporter.shownOnSurface('warning', `${gesture} left out what it could not search or open.`, why);
    return found;
  };

  /** Each copy, in an active or a compiled plugin, of a record whose EditorID or FormKey holds `query`, saying how many
   *  match; a cancelled search asks nothing further, and no listing asks for a copy's document. */
  const symbolsFor = async (query: string, { gesture, cancelled }: SymbolSearch): Promise<RecordSymbol[]> => {
    const plugins = await pluginsListed(gesture);
    if (plugins === undefined || cancelled()) return [];
    const searches = await Promise.all([searched(query), ...compiledOutsideTheLoadOrder(plugins).map((plugin) => searched(query, plugin))]);
    const pages = searches.filter((page) => typeof page !== 'string');
    const items = pages.flatMap((page) => page.items);
    const total = pages.reduce((sum, page) => sum + page.total, 0);
    if (items.length < total) {
      reporter.shownOnSurface('warning', `${gesture} lists ${items.length} of the ${total} copies of records whose EditorID or FormKey holds "${query}".`,
        namesOneRecord(query, items) ? undefined : 'Type more of the EditorID or FormKey to narrow the list.');
    }
    return listed(plugins, searches, gesture);
  };

  /** Each copy of `formKey` in a compiled plugin outside the load order. */
  const compiledCopiesOf = async (formKey: string, gesture: string): Promise<RecordSymbol[]> => {
    const plugins = await pluginsListed(gesture);
    if (plugins === undefined) return [];
    const searches = await Promise.all(compiledOutsideTheLoadOrder(plugins).map((plugin) => searched(formKey, plugin)));
    return listed(plugins, searches, gesture, (row) => row.formKey === formKey);
  };

  /** Where the copy the user picked opens: its FormKey member in its document. */
  const locate = async ({ name, formKey, plugin }: RecordSymbol, gesture: string): Promise<RecordLocation<Document> | undefined> => {
    try {
      const found = await locateRecord({ client, open }, { formKey, plugin }, declarationIn);
      if (found === undefined || !('refused' in found)) return found;
      reporter.shownOnSurface('warning', `${gesture} cannot open ${name}.`, found.refused);
      return undefined;
    } catch (error) {
      reporter.shownOnSurface('error', `${gesture} cannot open ${name}.`, errorMessage(error));
      return undefined;
    }
  };
  return { symbolsFor, compiledCopiesOf, locate };
}

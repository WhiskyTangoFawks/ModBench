import { errorMessage } from '../ports/errorMessage';
import type { Reporter } from '../ports/reporter';
import { namesPlugin, type CopyNaming, type HeldTexts, type PlaceInFile, type PluginSymbol, type ResolvedPlugin, type SymbolOwner, type SymbolReading } from '../symbolNames/symbolNames';
import { heldText } from '../textDocuments/heldText';
import { pluginRowName } from '../wire/pluginAddress';
import { locateCopies, type RecordLocation, type RecordLocationDeps } from './recordLocation';
import { pluginNameSpans } from './sourceText';

interface PluginReferencesDeps<Document> extends RecordLocationDeps<Document> {
  owners: readonly SymbolOwner[];
  /** The instance's plugin rows, which a file name alone resolves through. */
  plugins: () => readonly ResolvedPlugin[];
  held: () => HeldTexts;
  reporter: Pick<Reporter, 'shownOnSurface'>;
}

export type PluginReference<Document> = PlaceInFile | RecordLocation<Document>;

const readBy = (owner: SymbolOwner, symbol: PluginSymbol, held: HeldTexts): Promise<SymbolReading> =>
  owner.read(symbol, held).catch((error: unknown) => ({ references: [], leftOut: [errorMessage(error)] }));

/** Each place a file names the plugin, as each owner of files says (ADR-0028); a place an owner could not read is
 *  shown as a warning that says why. */
export function pluginReferencesOf<Document extends { getText(): string }>(
  { owners, plugins, held, reporter, client, open }: PluginReferencesDeps<Document>,
): (symbol: PluginSymbol) => Promise<PluginReference<Document>[]> {
  return async (symbol) => {
    const readings = await Promise.all(owners.map((owner) => readBy(owner, symbol, held())));
    const rows = plugins();
    const naming = readings.flatMap(({ references }) => references).filter(({ names }) => namesPlugin(names, symbol, rows));
    const places = naming.flatMap((reference) => ('place' in reference ? [reference.place] : []));
    const copies = naming.flatMap((reference): CopyNaming[] => ('copy' in reference ? [reference.copy] : []));
    const { found, leftOut } = await locateCopies(client, copies, async (copy, uri) => {
      const document = await open(uri);
      return pluginNameSpans(heldText(document), copy.formKey, symbol.name).map((span) => ({ uri, document, ...span }));
    });
    const unread = [...readings.flatMap((reading) => reading.leftOut), ...leftOut];
    if (unread.length > 0) {
      reporter.shownOnSurface('warning', `Find All References on ${pluginRowName(symbol)} left out what it could not read.`, unread.join('\n'));
    }
    return [...places, ...found.flat()];
  };
}

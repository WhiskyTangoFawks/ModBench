import { namesPlugin, type CopyNaming, type HeldTexts, type PlaceInFile, type PluginSymbol, type ResolvedPlugin, type SymbolOwner } from '../symbolNames/symbolNames';
import { heldText } from '../textDocuments/heldText';
import { locateCopies, type RecordLocation, type RecordLocationDeps } from './recordLocation';
import { pluginNameSpans } from './formKeyText';
import { readBy } from './symbolPlaces';

interface PluginReferencesDeps<Document> extends RecordLocationDeps<Document> {
  owners: readonly SymbolOwner[];
  /** The instance's plugin rows, which a file name alone resolves through. */
  plugins: () => readonly ResolvedPlugin[];
  held: () => HeldTexts;
}

export type PluginReference<Document> = PlaceInFile | RecordLocation<Document>;

interface PluginReferences<Document> {
  readonly found: readonly PluginReference<Document>[];
  readonly unread: readonly string[];
}

type Read<Document> = (symbol: PluginSymbol) => Promise<PluginReferences<Document>>;

/** Each place a file names the plugin, as each owner of files says (ADR-0028), and why each file went unread. */
export function pluginReferencesOf<Document extends { getText(): string }>(
  { owners, plugins, held, client, open }: PluginReferencesDeps<Document>,
): Read<Document> {
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
    return { found: [...places, ...found.flat()], unread: [...readings.flatMap((reading) => reading.leftOut), ...leftOut] };
  };
}

import type { Reporter } from '../ports/reporter';
import { namesPlugin, type CopyNaming, type HeldTexts, type PlaceInFile, type PluginSymbol, type ResolvedPlugin, type SymbolOwner } from '../symbolNames/symbolNames';
import { heldText } from '../textDocuments/heldText';
import { pluginRowName } from '../wire/pluginAddress';
import { locateCopies, type RecordLocation, type RecordLocationDeps } from './recordLocation';
import { pluginNameSpans } from './sourceText';
import { readBy, reportedForFeature, reportedForGesture } from './symbolPlaces';

interface PluginReferencesDeps<Document> extends RecordLocationDeps<Document> {
  owners: readonly SymbolOwner[];
  /** The instance's plugin rows, which a file name alone resolves through. */
  plugins: () => readonly ResolvedPlugin[];
  held: () => HeldTexts;
  reporter: Pick<Reporter, 'report' | 'shownOnSurface'>;
}

export type PluginReference<Document> = PlaceInFile | RecordLocation<Document>;

interface PluginReferences<Document> {
  readonly found: readonly PluginReference<Document>[];
  readonly unread: readonly string[];
}


type Read<Document> = (symbol: PluginSymbol) => Promise<PluginReferences<Document>>;

/** Each place a file names the plugin, as each owner of files says (ADR-0028). What went unread is a notification for
 *  the gesture, and a line in the Output each for Find All References (common.md, Reporting). */
export function pluginReferencesOf<Document extends { getText(): string }>(
  deps: PluginReferencesDeps<Document>,
): { forGesture: Read<Document>; forFeature: Read<Document> } {
  const read = readReferences(deps);
  const { reporter } = deps;
  return {
    forGesture: async (symbol) => reportedForGesture(reporter, pluginRowName(symbol), await read(symbol)),
    forFeature: async (symbol) => reportedForFeature(reporter, pluginRowName(symbol), await read(symbol)),
  };
}

function readReferences<Document extends { getText(): string }>(
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

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
  reporter: Pick<Reporter, 'report'>;
}

export type PluginReference<Document> = PlaceInFile | RecordLocation<Document>;

/** The places found, and why each file or copy that may name the plugin went unread. */
export interface PluginReferences<Document> {
  readonly found: readonly PluginReference<Document>[];
  readonly unread: readonly string[];
}

const readBy = (owner: SymbolOwner, symbol: PluginSymbol, held: HeldTexts): Promise<SymbolReading> =>
  owner.read(symbol, held).catch((error: unknown) => ({ references: [], leftOut: [errorMessage(error)] }));

/** The line above a plugin's list: an empty list says so, and that it is no proof while a file went unread. */
export function listMessage(found: number, unread: number): string | undefined {
  if (found > 0) return undefined;
  return unread > 0 ? 'No references found in the files that could be read.' : 'No references found.';
}

/** Each place a file names the plugin, as each owner of files says (ADR-0028); a notification names each file or copy
 *  that could not be read, as the list without them is not the whole answer (common.md, Reporting). */
export function pluginReferencesOf<Document extends { getText(): string }>(
  { owners, plugins, held, reporter, client, open }: PluginReferencesDeps<Document>,
): (symbol: PluginSymbol) => Promise<PluginReferences<Document>> {
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
      reporter.report('warning', `Find All References on ${pluginRowName(symbol)} could not read every file that may name it.`, unread.join('\n'));
    }
    return { found: [...places, ...found.flat()], unread };
  };
}

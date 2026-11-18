import type * as vscode from 'vscode';
import { namesPlugin, type HeldTexts, type PluginSymbol, type ResolvedPlugin, type SymbolOwner } from '../symbolNames/symbolNames';
import { placedLocations } from './placedReferences';
import { placeLocation, readBy } from './symbolPlaces';

interface PluginReferencesDeps {
  owners: readonly SymbolOwner[];
  /** The instance's plugin rows, which a file name alone resolves through. */
  plugins: () => readonly ResolvedPlugin[];
  held: () => HeldTexts;
}

interface PluginReferences {
  readonly found: readonly vscode.Location[];
  readonly unread: readonly string[];
}

/** Each place a file names the plugin, as each owner of files says (ADR-0028), and why each file went unread. */
export function pluginReferencesOf({ owners, plugins, held }: PluginReferencesDeps): (symbol: PluginSymbol) => Promise<PluginReferences> {
  return async (symbol) => {
    const readings = await Promise.all(owners.map((owner) => readBy(owner, symbol, held())));
    const rows = plugins();
    const naming = readings.flatMap(({ references }) => references).filter(({ names }) => namesPlugin(names, symbol, rows));
    const places = naming.flatMap((reference) => ('place' in reference ? [placeLocation(reference.place)] : []));
    const copies = placedLocations(naming.flatMap((reference) => ('copy' in reference ? [reference.copy] : [])));
    const unreadCopies = naming.flatMap((reference) => ('unread' in reference ? [reference.unread] : []));
    return { found: [...places, ...copies], unread: [...readings.flatMap((reading) => reading.leftOut), ...unreadCopies] };
  };
}

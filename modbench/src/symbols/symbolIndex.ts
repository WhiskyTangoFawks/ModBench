import type { CopyNaming, PlaceInFile, PluginSymbol } from '../symbolNames/symbolNames';
import { copyOf, RENDERED_DOCUMENT_SCHEME } from '../textDocuments/recordDocument';
import { asked, type Definition, type SymbolKinds, type SymbolName } from './symbolKind';
import { placeOfLocation, referenceOf } from './symbolPlaces';

type DefinitionRead =
  | { readonly place: PlaceInFile }
  | { readonly plugin: PluginSymbol }
  | { readonly file: string }
  | { readonly row: string }
  | { readonly archived: { readonly archive: string; readonly file: string } }
  | { readonly none: string }
  | { readonly refused: string };

type SymbolReferences = {
  readonly references: readonly (PlaceInFile | CopyNaming)[];
  readonly leftOut: readonly string[];
};

/** The agent's entry point to every symbol's answers (agent.md, Names, story 4). */
export interface SymbolIndex {
  definitionOf(symbol: SymbolName): Promise<DefinitionRead>;
  referencesTo(symbol: SymbolName): Promise<SymbolReferences | { readonly refused: string }>;
}

function read(definition: Definition): DefinitionRead {
  if ('at' in definition) {
    const { at } = definition;
    return at.uri.scheme === RENDERED_DOCUMENT_SCHEME ? { plugin: copyOf(at.uri).plugin } : { place: placeOfLocation(at) };
  }
  if ('row' in definition) return { row: definition.row };
  if (!('shown' in definition)) return definition;
  const { shown } = definition;
  return shown.kind === 'loose' ? { file: shown.path } : { archived: { archive: shown.archive, file: shown.file } };
}

export function symbolIndex(kinds: SymbolKinds): SymbolIndex {
  return {
    definitionOf: async (symbol) => read(await asked(kinds, symbol).definition()),
    async referencesTo(symbol) {
      const found = await asked(kinds, symbol).references();
      return 'refused' in found ? found : { references: found.locations.map(referenceOf), leftOut: found.unread };
    },
  };
}

import type * as vscode from 'vscode';
import type { MEditClient } from '../client';
import { errorMessage } from '../ports/errorMessage';
import type { CopyNaming, EntrySymbol, PlaceInFile, PluginName, PluginSymbol, ScriptSymbol } from '../symbolNames/symbolNames';
import { copyOf, RENDERED_DOCUMENT_SCHEME, type RecordDocumentClient } from '../textDocuments/recordDocument';
import type { entryLanguage } from './entryLanguage';
import type { fileLanguage } from './fileLanguage';
import type { pluginLanguage } from './pluginLanguage';
import type { scriptLanguage } from './scriptLanguage';
import { locateRecord, locationOf } from './recordLocation';
import { referencesToFormKey } from './formKeyReferences';
import { formKeyMember } from './sourceText';
import { placeOfLocation, referenceOf } from './symbolPlaces';

/** A symbol by its name: a record by its FormKey, a file by its path in the Data folder. */
export type SymbolName =
  | ({ readonly kind: 'plugin' } & PluginName)
  | { readonly kind: 'record'; readonly formKey: string }
  | EntrySymbol
  | ScriptSymbol
  | { readonly kind: 'file'; readonly path: string };

/** Where a symbol is defined (symbols.md, The symbols). `none` says its kind has no definition, `refused` why this
 *  symbol has none to give. */
export type Definition =
  | { readonly file: string }
  | { readonly place: PlaceInFile }
  | { readonly plugin: PluginSymbol }
  | { readonly archived: { readonly archive: string; readonly file: string } }
  | { readonly none: string }
  | { readonly refused: string };

/** Each place a file names a symbol, each at the record that holds it where its plugin has no plugin source, and why
 *  each file went unread. */
export interface SymbolReferences {
  readonly references: readonly (PlaceInFile | CopyNaming)[];
  readonly leftOut: readonly string[];
}

export interface SymbolIndex {
  definitionOf(symbol: SymbolName): Promise<Definition>;
  referencesTo(symbol: SymbolName): Promise<SymbolReferences | { readonly refused: string }>;
}

interface SymbolIndexDeps {
  client: RecordDocumentClient & Pick<MEditClient, 'getReferencesInActiveOrCompiledPlugins'>;
  open: (uri: vscode.Uri) => PromiseLike<Pick<vscode.TextDocument, 'getText' | 'positionAt'>>;
  plugin: Pick<ReturnType<typeof pluginLanguage>, 'definitionOf' | 'placesNaming'>;
  entry: Pick<ReturnType<typeof entryLanguage>, 'definitionOf' | 'placesNaming'>;
  script: Pick<ReturnType<typeof scriptLanguage>, 'definitionOf' | 'placesNaming'>;
  file: Pick<ReturnType<typeof fileLanguage>, 'definitionOf' | 'placesNaming'>;
}

export function symbolIndex({ client, open, plugin, entry, script, file }: SymbolIndexDeps): SymbolIndex {
  const references = referencesToFormKey({ client, open });
  return {
    async definitionOf(symbol) {
      switch (symbol.kind) {
        case 'plugin': return plugin.definitionOf(symbol);
        case 'script': return script.definitionOf(symbol.name);
        case 'file': return file.definitionOf(symbol.path);
        case 'record': {
          const located = await locateRecord({ client, open }, { formKey: symbol.formKey }, formKeyMember)
            .catch((error: unknown) => ({ refused: `Where ${symbol.formKey} is defined could not be read: ${errorMessage(error)}` }));
          if (located === undefined) return { refused: `No active plugin holds ${symbol.formKey}.` };
          if ('refused' in located) return located;
          if (located.uri.scheme === RENDERED_DOCUMENT_SCHEME) return { plugin: copyOf(located.uri).plugin };
          return { place: placeOfLocation(locationOf(located)) };
        }
        case 'mod': case 'separator': case 'downloadedFile': case 'profile': return entry.definitionOf(symbol);
      }
    },
    async referencesTo(symbol) {
      switch (symbol.kind) {
        case 'plugin': return plugin.placesNaming(symbol);
        case 'script': return script.placesNaming(symbol.name);
        case 'file': return file.placesNaming(symbol.path);
        case 'record':
          try {
            const { found, leftOut } = await references(symbol.formKey);
            return { references: found.map((location) => referenceOf(locationOf(location))), leftOut };
          } catch (error) {
            return { refused: `mEdit cannot list what references ${symbol.formKey}: ${errorMessage(error)}` };
          }
        case 'mod': case 'separator': case 'downloadedFile': case 'profile': return entry.placesNaming(symbol);
      }
    },
  };
}

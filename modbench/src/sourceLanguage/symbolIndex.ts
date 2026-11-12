import type * as vscode from 'vscode';
import type { MEditClient } from '../client';
import { errorMessage } from '../ports/errorMessage';
import type { SymbolIndex } from '../symbolNames/symbolNames';
import { copyOf, RENDERED_DOCUMENT_SCHEME, type RecordDocumentClient } from '../textDocuments/recordDocument';
import type { entryLanguage } from './entryLanguage';
import type { fileLanguage } from './fileLanguage';
import type { pluginLanguage } from './pluginLanguage';
import type { scriptLanguage } from './scriptLanguage';
import { locateRecord, locationOf } from './recordLocation';
import { referencesToFormKey } from './formKeyReferences';
import { formKeyMember } from './sourceText';
import { placeOfLocation, referenceOf } from './symbolPlaces';

interface SymbolIndexDeps {
  client: RecordDocumentClient & Pick<MEditClient, 'getReferencesInActiveOrCompiledPlugins'>;
  open: (uri: vscode.Uri) => PromiseLike<vscode.TextDocument>;
  plugin: Pick<ReturnType<typeof pluginLanguage>, 'definitionOf' | 'placesNaming'>;
  entry: Pick<ReturnType<typeof entryLanguage>, 'definitionOf' | 'placesNaming'>;
  script: Pick<ReturnType<typeof scriptLanguage>, 'definitionOf' | 'placesNaming'>;
  file: Pick<ReturnType<typeof fileLanguage>, 'definitionOf' | 'placesNaming'>;
}

/** What the editor's Go to Definition and Find All References read, by symbol instead of by text position. */
export function symbolIndex({ client, open, plugin, entry, script, file }: SymbolIndexDeps): SymbolIndex {
  const references = referencesToFormKey({ client, open });
  return {
    async definitionOf(symbol) {
      switch (symbol.kind) {
        case 'plugin': return plugin.definitionOf(symbol);
        case 'script': return script.definitionOf(symbol.name);
        case 'file': return file.definitionOf(symbol.path);
        case 'record': {
          const located = await locateRecord({ client, open }, { formKey: symbol.formKey }, formKeyMember);
          if (located === undefined) return { refused: `No active plugin holds ${symbol.formKey}.` };
          if ('refused' in located) return located;
          if (located.uri.scheme === RENDERED_DOCUMENT_SCHEME) return { plugin: copyOf(located.uri).plugin };
          return { place: placeOfLocation(locationOf(located)) };
        }
        default: return entry.definitionOf(symbol);
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
        default: return entry.placesNaming(symbol);
      }
    },
  };
}

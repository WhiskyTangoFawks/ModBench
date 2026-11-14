import * as vscode from 'vscode';
import { formKeyMember, type MEditClient, type PluginSourceNames } from '../client';
import { errorMessage } from '../ports/errorMessage';
import type { Reporter } from '../ports/reporter';
import { heldText } from '../textDocuments/heldText';
import type { RecordDocumentClient } from '../textDocuments/recordDocument';
import { hoverOf } from './formKeyHover';
import { referencesToFormKey } from './formKeyReferences';
import { locateRecord, locationOf } from './recordLocation';
import type { Definition, RecordNamed, References, SymbolKind } from './symbolKind';
import { workspaceSymbolsOf } from './workspaceSymbols';

export type RecordClient = RecordDocumentClient & Pick<MEditClient, 'getComparison' | 'searchRecords' | 'getReferencesInActiveOrCompiledPlugins' | 'getPlugins'>;

interface RecordLanguageDeps {
  client: RecordClient;
  names: Pick<PluginSourceNames, 'recordAt' | 'recordsOfferedAt'>;
  reporter: Pick<Reporter, 'shownOnSurface'>;
  open: (uri: vscode.Uri) => PromiseLike<Pick<vscode.TextDocument, 'getText' | 'positionAt'>>;
}

/** A record as a symbol: its FormKey in plugin source, and every answer from the active and the compiled plugins mEdit
 *  reads (symbols.md, The symbols, Record). */
export function recordLanguage({ client, names, reporter, open }: RecordLanguageDeps): SymbolKind<RecordNamed> {
  const references = referencesToFormKey({ client, open });
  const workspace = workspaceSymbolsOf({ client, reporter, open });
  return {
    nameAt(document, offset) {
      const found = names.recordAt(document.uri.fsPath, heldText(document), offset);
      return Promise.resolve(found && { start: found.start, end: found.end, name: found.formKey, symbol: { kind: 'record', formKey: found.formKey } });
    },
    /** Its winning copy's FormKey member. */
    async definitionOf({ formKey }): Promise<Definition> {
      const located = await locateRecord({ client, open }, { formKey }, formKeyMember)
        .catch((error: unknown) => ({ refused: `Where ${formKey} is defined could not be read: ${errorMessage(error)}` }));
      if (located === undefined) return { refused: `No active plugin holds ${formKey}.` };
      return 'refused' in located ? located : { at: locationOf(located) };
    },
    async referencesTo({ formKey }): Promise<References> {
      try {
        const { found, leftOut } = await references(formKey);
        return { locations: found.map(locationOf), unread: leftOut };
      } catch (error) {
        return { refused: `mEdit cannot list what references ${formKey}: ${errorMessage(error)}` };
      }
    },
    /** What symbols.md, The symbols, says a record's hover shows; none where no active plugin holds it. */
    tooltipOf: async ({ formKey }) => await hoverOf({ client, reporter }, formKey) ?? [],
    /** The records a reference field offers for the text typed so far. */
    async completionsAt(document, offset) {
      const found = await names.recordsOfferedAt(document.uri.fsPath, heldText(document), offset);
      return found && { ...found, icon: vscode.CompletionItemKind.Reference, isIncomplete: true };
    },
    /** Each compiled plugin's copy of a record whose EditorID or FormKey holds `query`, at its document. */
    async symbolsFor(query) {
      return (await workspace.symbolsFor(query)).map((record) => ({
        name: record.name, detail: `${record.plugin.name} (${record.plugin.origin})`, icon: vscode.SymbolKind.Object,
        location: new vscode.Location(record.uri, new vscode.Position(0, 0)),
        resolve: async () => {
          const found = await workspace.locate(record);
          return found && locationOf(found);
        },
      }));
    },
  };
}

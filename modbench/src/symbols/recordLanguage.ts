import * as vscode from 'vscode';
import type { MEditClient } from '../client';
import { errorMessage } from '../ports/errorMessage';
import type { Reporter } from '../ports/reporter';
import { heldText } from '../textDocuments/heldText';
import type { RecordDocumentClient } from '../textDocuments/recordDocument';
import { hoverOf } from './formKeyHover';
import { referencesToFormKey } from './formKeyReferences';
import { locateRecord, locationOf } from './recordLocation';
import type { SourceNames } from './sourceNames';
import { REFERENCED_BY, type Definition, type RecordNamed, type References, type SymbolKind } from './symbolKind';
import { recordReferencedBy, type RecordReferencedByDeps } from './recordReferencedBy';
import { workspaceSymbolsOf } from './workspaceSymbols';

export type RecordClient = RecordDocumentClient & RecordReferencedByDeps['client']
  & Pick<MEditClient, 'getComparison' | 'searchRecords' | 'getReferencesInActiveOrCompiledPlugins' | 'getPlugins'>;

interface RecordLanguageDeps {
  client: RecordClient;
  names: Pick<SourceNames, 'recordAt' | 'recordsOfferedAt' | 'declarationIn' | 'referenceIn' | 'formKeyIn'>;
  reporter: Pick<Reporter, 'shownOnSurface' | 'report'>;
  open: (uri: vscode.Uri) => PromiseLike<Pick<vscode.TextDocument, 'getText' | 'positionAt'>>;
}

const noActivePluginHolds = (formKey: string): string => `No active plugin holds ${formKey}.`;

/** A record as a symbol: its FormKey in plugin source, and every answer from the active and the compiled plugins mEdit
 *  reads (symbols.md, The symbols, Record). */
export function recordLanguage({ client, names, reporter, open }: RecordLanguageDeps): SymbolKind<RecordNamed> {
  const references = referencesToFormKey({ client, open, spanIn: names.referenceIn });
  const workspace = workspaceSymbolsOf({ client, reporter, open, declarationIn: names.declarationIn });
  /** Its winning copy's FormKey member. */
  const definitionOf = async ({ formKey }: RecordNamed): Promise<Definition> => {
    const located = await locateRecord({ client, open }, { formKey }, names.declarationIn)
      .catch((error: unknown) => ({ refused: `Where ${formKey} is defined could not be read: ${errorMessage(error)}` }));
    if (located === undefined) return { refused: noActivePluginHolds(formKey) };
    return 'refused' in located ? located : { at: locationOf(located) };
  };
  /** Its FormKey in its winning copy; with no active plugin holding it, the top of a compiled plugin's copy. */
  const anchorOf = async ({ formKey }: RecordNamed): Promise<vscode.Location | { refused: string }> => {
    const winning = await locateRecord({ client, open }, { formKey }, names.formKeyIn);
    if (winning !== undefined) return 'refused' in winning ? winning : locationOf(winning);
    const [compiled] = await workspace.compiledCopiesOf(formKey, REFERENCED_BY);
    return compiled ? new vscode.Location(compiled.uri, new vscode.Position(0, 0)) : { refused: noActivePluginHolds(formKey) };
  };
  const referencedBy = recordReferencedBy({ client, reporter, anchorOf });
  return {
    async nameAt(document, offset) {
      const found = await names.recordAt(document.uri.fsPath, heldText(document), offset);
      return found && { start: found.start, end: found.end, name: found.formKey, symbol: { kind: 'record', formKey: found.formKey } };
    },
    definitionOf,
    async referencesTo({ formKey }): Promise<References> {
      try {
        const { found, leftOut } = await references(formKey);
        return { locations: found.map(locationOf), unread: leftOut };
      } catch (error) {
        return { refused: `mEdit cannot list what references ${formKey}: ${errorMessage(error)}` };
      }
    },
    referencedBy,
    /** What symbols.md, The symbols, says a record's hover shows; none where no active plugin holds it. */
    tooltipOf: async ({ formKey }) => await hoverOf({ client, reporter }, formKey) ?? [],
    /** The records a reference field offers for the text typed so far. */
    async completionsAt(document, offset) {
      const found = await names.recordsOfferedAt(document.uri.fsPath, heldText(document), offset);
      return found && { ...found, icon: vscode.CompletionItemKind.Reference, isIncomplete: true };
    },
    /** Each copy, in an active or a compiled plugin, of a record whose EditorID or FormKey holds `query`, at its document. */
    async symbolsFor(query, gesture) {
      return (await workspace.symbolsFor(query, gesture)).map((record) => ({
        symbol: { kind: 'record', formKey: record.formKey }, name: record.name, detail: `${record.plugin.name} (${record.plugin.origin})`, icon: vscode.SymbolKind.Object,
        location: new vscode.Location(record.uri, new vscode.Position(0, 0)),
        resolve: async () => {
          const found = await workspace.locate(record, gesture);
          return found && locationOf(found);
        },
      }));
    },
  };
}

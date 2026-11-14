import * as vscode from 'vscode';
import type { MEditClient } from '../client';
import { errorMessage } from '../ports/errorMessage';
import type { Reporter } from '../ports/reporter';
import { heldText } from '../textDocuments/heldText';
import { ownerOf, type RecordDocumentClient } from '../textDocuments/recordDocument';
import { hoverOf } from './formKeyHover';
import { referencesToFormKey } from './formKeyReferences';
import { locateRecord, locationOf } from './recordLocation';
import type { SourceNames } from './sourceNames';
import { type Definition, type RecordNamed, type References, type SymbolKind } from './symbolKind';
import { recordReferencedBy, type RecordReferencedByDeps } from './recordReferencedBy';
import { workspaceSymbolsOf } from './workspaceSymbols';
import { recordLabel } from '../wire/recordLabel';
import type { PluginAddress } from '../wire/pluginAddress';

export type RecordClient = RecordDocumentClient & RecordReferencedByDeps['client']
  & Pick<MEditClient, 'getComparison' | 'searchRecords' | 'getPlacedReferences' | 'getPlugins'>;

interface RecordLanguageDeps {
  client: RecordClient;
  names: Pick<SourceNames, 'recordAt' | 'referenceTypedAt' | 'declarationIn' | 'formKeyIn'>;
  reporter: Pick<Reporter, 'shownOnSurface' | 'report'>;
  open: (uri: vscode.Uri) => PromiseLike<Pick<vscode.TextDocument, 'getText' | 'positionAt'>>;
}

const noActivePluginHolds = (formKey: string): string => `No active plugin holds ${formKey}.`;

/** A record as a symbol: its FormKey in plugin source, and every answer from the active and the compiled plugins mEdit
 *  reads (symbols.md, The symbols, Record). */
export function recordLanguage({ client, names, reporter, open }: RecordLanguageDeps): SymbolKind<RecordNamed> {
  const references = referencesToFormKey({ client, open });
  const workspace = workspaceSymbolsOf({ client, reporter, open, declarationIn: names.declarationIn });
  /** Its FormKey member in the document it opens as. */
  const definitionOf = async ({ formKey }: RecordNamed): Promise<Definition> => {
    const located = await locateRecord({ client, open }, { formKey }, names.declarationIn)
      .catch((error: unknown) => ({ refused: `Where ${formKey} is defined could not be read: ${errorMessage(error)}` }));
    if (located === undefined) return { refused: noActivePluginHolds(formKey) };
    return 'refused' in located ? located : { at: locationOf(located) };
  };
  const anchorIn = async (formKey: string, plugin: PluginAddress): Promise<vscode.Location | { refused: string }> => {
    const located = await locateRecord({ client, open }, { formKey, plugin }, names.formKeyIn);
    if (located === undefined) return { refused: noActivePluginHolds(formKey) };
    return 'refused' in located ? located : locationOf(located);
  };
  /** Its FormKey in the copy it opens as; of several owners, in the first one's, since the anchor only places the view. */
  const anchorOf = async ({ formKey }: RecordNamed): Promise<vscode.Location | { refused: string }> => {
    const owner = await ownerOf(client, formKey);
    if (owner === undefined) return { refused: noActivePluginHolds(formKey) };
    if (!('refused' in owner)) return anchorIn(formKey, owner);
    const [first] = owner.owners;
    return first ? anchorIn(formKey, first) : owner;
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
    /** The records of the types a reference field allows whose EditorID or FormKey holds the text typed so far, each
     *  once, found as Go to Symbol in Workspace finds them; nothing before anything is typed. */
    async completionsAt(document, offset, search) {
      const found = await names.referenceTypedAt(document.uri.fsPath, heldText(document), offset);
      if (found === undefined || found.typed === '') return undefined;
      const { found: records, isIncomplete } = await workspace.recordsFor(found.typed, search, { types: found.types, eachRecordOnce: true });
      return {
        start: found.start, end: found.end, icon: vscode.CompletionItemKind.Reference, isIncomplete,
        items: records.map(({ editorId, formKey }) => ({ label: editorId || formKey, detail: formKey, insertText: formKey })),
      };
    },
    /** Each copy, in an active or a compiled plugin, of a record whose EditorID or FormKey holds `query`, at its plugin's
     *  file until the user picks it, and then at its document. */
    async symbolsFor(query, search) {
      return (await workspace.symbolsFor(query, search)).map((record) => {
        const name = recordLabel(record.editorId, record.formKey);
        return {
          symbol: { kind: 'record', formKey: record.formKey }, name, detail: `${record.plugin.name} (${record.plugin.origin})`, icon: vscode.SymbolKind.Object,
          location: new vscode.Location(vscode.Uri.file(record.pluginFile), new vscode.Position(0, 0)),
          // A resolve that answers nothing leaves VS Code opening the plugin's file, which is not the record.
          resolve: async () => {
            const found = await workspace.locate(record, search.gesture);
            if (found === undefined) throw new Error(`${search.gesture} cannot open ${name}.`);
            return locationOf(found);
          },
        };
      });
    },
  };
}

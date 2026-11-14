import * as vscode from 'vscode';
import type { MEditClient } from '../client';
import type { Reporter } from '../ports/reporter';
import type { InstanceValue, PapyrusScript } from '../instanceLoader/instance';
import { sameName, type ScriptSymbol } from '../symbolNames/symbolNames';
import { heldText } from '../textDocuments/heldText';
import { openPluginSourceDocument } from '../textDocuments/pluginSource';
import type { RecordDocumentClient } from '../textDocuments/recordDocument';
import { membersNaming } from './memberReferences';
import type { SourceNames } from './sourceNames';
import { atFile, nameHolds, showReferencedBy, type AskedIn } from './symbolPlaces';
import type { Definition, References, SymbolKind } from './symbolKind';

export type ScriptClient = Pick<MEditClient, 'getScriptReferences'> & RecordDocumentClient;

interface ScriptLanguageDeps {
  instance: { readonly value: Pick<InstanceValue, 'papyrusScripts' | 'dataFolderFiles'> } | undefined;
  names: Pick<SourceNames, 'scriptAt' | 'scriptsIn' | 'scriptsNamed' | 'membersIn' | 'formKeyIn'>;
  client: ScriptClient;
  reporter: Pick<Reporter, 'report' | 'shownOnSurface'>;
}

/** A Papyrus script as a symbol: where plugin source names one a record attaches, and the records that attach it, which
 *  mEdit answers (symbols.md). */
export function scriptLanguage({ instance, names, client, reporter }: ScriptLanguageDeps): SymbolKind<ScriptSymbol> & Required<Pick<SymbolKind<ScriptSymbol>, 'namesNothingIn' | 'filesNamingNothing'>> {
  const scripts = (): readonly PapyrusScript[] => instance?.value.papyrusScripts ?? [];

  const judged = (): boolean => instance?.value.dataFolderFiles.kind === 'listed';
  const held = (name: string): boolean => scripts().some((script) => sameName(script.name, name));

  const nameAt = (document: AskedIn, offset: number) => names.scriptAt(document.uri.fsPath, heldText(document), offset);

  const fileOf = ({ source, compiled }: PapyrusScript): string | undefined => source ?? compiled;

  const referencesTo = async ({ name }: ScriptSymbol): Promise<References> => {
    const { found, unread } = await membersNaming(client, openPluginSourceDocument, names, await client.getScriptReferences(name));
    return { locations: found, unread };
  };

  return {
    async nameAt(document, offset) {
      const found = await nameAt(document, offset);
      return found && { start: found.start, end: found.end, name: found.name, symbol: { kind: 'script', name: found.name } };
    },
    /** Its source, else its compiled script, else the archive's copy. */
    definitionOf({ name }): Promise<Definition> {
      const script = scripts().find((each) => sameName(each.name, name));
      if (script === undefined) return Promise.resolve({ refused: `No mod, Overwrite or the Data folder holds a source or a compiled script of ${name}.` });
      const file = fileOf(script);
      if (file !== undefined) return Promise.resolve({ file });
      return Promise.resolve(script.archived === undefined ? { refused: `No file holds ${name}.` } : { shown: script.archived });
    },
    /** Each member of a record that names it. */
    referencesTo,
    referencedBy: (script) => showReferencedBy({
      reporter, subject: script.name, contextValue: 'modbench.scriptReferencedBy', references: () => referencesTo(script),
    }),
    /** Each script plugin source names that nothing holds, once the Data folder is listed. */
    async namesNothingIn(document) {
      if (!judged()) return [];
      const found = await names.scriptsIn(document.uri.fsPath, heldText(document));
      return found.filter(({ name }) => !held(name))
        .map(({ start, end, name }) => ({ start, end, name, why: `No mod, Overwrite or the Data folder holds ${name}.` }));
    },
    /** Each file plugin source holds that names a script nothing holds. */
    async filesNamingNothing() {
      if (!judged()) return [];
      return [...new Set((await names.scriptsNamed()).filter(({ name }) => !held(name)).map(({ file }) => file))];
    },
    /** None: a script has no row. */
    tooltipOf: () => Promise.resolve([]),
    async completionsAt(document, offset) {
      const found = await nameAt(document, offset);
      return found && { start: found.start, end: found.end, icon: vscode.CompletionItemKind.Class, items: scripts().map(({ name }) => ({ label: name })) };
    },
    /** Each script whose name holds `query`, at its source, else its compiled script. */
    symbolsFor(query) {
      return Promise.resolve(scripts().filter(({ name }) => nameHolds(name, query)).flatMap((script) => {
        const file = fileOf(script);
        return file === undefined ? [] : [{ symbol: { kind: 'script', name: script.name }, name: script.name, detail: 'Papyrus script', icon: vscode.SymbolKind.Class, location: atFile(file) }];
      }));
    },
  };
}

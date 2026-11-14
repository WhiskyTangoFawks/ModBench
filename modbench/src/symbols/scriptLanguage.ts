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
  instance: { readonly value: ScriptsValue } | undefined;
  names: Pick<SourceNames, 'scriptAt' | 'scriptsIn' | 'scriptsNamed' | 'membersIn' | 'formKeyIn'>;
  client: ScriptClient;
  reporter: Pick<Reporter, 'report' | 'shownOnSurface'>;
}

type ScriptsValue = Pick<InstanceValue, 'papyrusScripts' | 'dataFolderFiles' | 'gameFolder' | 'gameFolderInWorkspace' | 'archiveContents'>;

// A script is held by nothing only once every place that could hold it has answered. A reason is given only where
// the state lasts; a place that has not answered yet is waited for.
function unjudgedBecause(value: ScriptsValue | undefined): { reason?: string } | undefined {
  if (value === undefined || value.dataFolderFiles.kind !== 'listed') return {};
  if (value.gameFolder.kind !== 'found') return { reason: 'The game folder is not found.' };
  if (!value.gameFolderInWorkspace) return { reason: `The game folder ${value.gameFolder.root} is outside the workspace, so its archives are not read.` };
  const archives = [...value.archiveContents];
  const unreadable = archives.find(([, read]) => read.kind === 'unreadable');
  if (unreadable?.[1].kind === 'unreadable') return { reason: `${unreadable[0]} cannot be read: ${unreadable[1].reason}` };
  return archives.some(([, read]) => read.kind !== 'read') ? {} : undefined;
}

/** A Papyrus script as a symbol: where plugin source names one a record attaches, and the records that attach it, which
 *  mEdit answers (symbols.md). */
export function scriptLanguage({ instance, names, client, reporter }: ScriptLanguageDeps): SymbolKind<ScriptSymbol> & Required<Pick<SymbolKind<ScriptSymbol>, 'namesNothingIn' | 'filesNamingNothing'>> {
  const scripts = (): readonly PapyrusScript[] => instance?.value.papyrusScripts ?? [];

  let toldWhy: string | undefined;
  const judged = (): boolean => {
    const unjudged = unjudgedBecause(instance?.value);
    if (unjudged?.reason !== toldWhy && unjudged?.reason !== undefined) {
      reporter.shownOnSurface('warning', 'The Problems panel does not check the scripts plugin source names.', unjudged.reason);
    }
    toldWhy = unjudged?.reason;
    return unjudged === undefined;
  };
  const isHeld = (name: string): boolean => scripts().some((script) => sameName(script.name, name));

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
    /** Its source, else its compiled script. */
    definitionOf({ name }): Promise<Definition> {
      const held = scripts().find((script) => sameName(script.name, name));
      const file = held && fileOf(held);
      return Promise.resolve(file === undefined ? { refused: `No mod, Overwrite or the Data folder holds a source or a compiled script of ${name}.` } : { file });
    },
    /** Each member of a record that names it. */
    referencesTo,
    referencedBy: (script) => showReferencedBy({
      reporter, subject: script.name, contextValue: 'modbench.scriptReferencedBy', references: () => referencesTo(script),
    }),
    /** Each script plugin source names that nothing holds; undefined where nothing can be said yet. */
    async namesNothingIn(document) {
      const found = await names.scriptsIn(document.uri.fsPath, heldText(document));
      if (found.length === 0) return [];
      if (!judged()) return undefined;
      return found.filter(({ name }) => !isHeld(name))
        .map(({ start, end, name }) => ({ start, end, name, why: `No mod, Overwrite, Data folder file or archive holds ${name}.` }));
    },
    /** Each file plugin source holds that names a script nothing holds; undefined where nothing can be said yet. */
    async filesNamingNothing(only) {
      const named = await names.scriptsNamed(only);
      if (named === undefined) return undefined;
      if (named.length === 0) return [];
      return judged() ? [...new Set(named.filter(({ name }) => !isHeld(name)).map(({ file }) => file))] : undefined;
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

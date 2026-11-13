import * as vscode from 'vscode';
import type { MEditClient } from '../client';
import type { InstanceValue, PapyrusScript } from '../instanceLoader/instance';
import { isPluginSourcePath } from '../instanceAdapter/instanceAdapter';
import { errorMessage } from '../ports/errorMessage';
import type { Reporter } from '../ports/reporter';
import { sameName, type ScriptSymbol } from '../symbolNames/symbolNames';
import { heldText } from '../textDocuments/heldText';
import { openPluginSourceDocument, readHeldText } from '../textDocuments/pluginSource';
import { fieldOfRecord } from '../drivingLib/fieldMetadata';
import { scriptReferences, type ScriptReferencesClient } from './scriptReferences';
import { fieldAt } from '../drivingLib/sourceText';
import { formKeyAt } from './formKeyText';
import type { AskedIn } from './symbolPlaces';
import type { Definition, SymbolKind } from './symbolKind';

export type ScriptClient = Pick<MEditClient, 'getComparison'> & ScriptReferencesClient;

interface ScriptLanguageDeps {
  instance: { readonly value: Pick<InstanceValue, 'papyrusScripts'> } | undefined;
  reporter: Pick<Reporter, 'shownOnSurface'>;
  client: ScriptClient;
}

const atFile = (file: string): vscode.Location => new vscode.Location(vscode.Uri.file(file), new vscode.Range(0, 0, 0, 0));

/** A Papyrus script as a symbol: where plugin source names one a record attaches, and the records that attach it, which
 *  mEdit answers (symbols.md). */
export function scriptLanguage({ instance, reporter, client }: ScriptLanguageDeps): SymbolKind<ScriptSymbol> {
  const scripts = (): readonly PapyrusScript[] => instance?.value.papyrusScripts ?? [];

  const nameAt = async (document: AskedIn, offset: number): Promise<{ name: string; start: number; end: number } | undefined> => {
    if (!isPluginSourcePath(document.uri.fsPath)) return undefined;
    const text = heldText(document);
    const found = fieldAt(text, offset);
    if (found === undefined || found.end - found.start <= 2 || formKeyAt(text, offset) !== undefined) return undefined;
    try {
      if (!(await fieldOfRecord(client, found))?.isScriptName) return undefined;
    } catch (error) {
      reporter.shownOnSurface('error', `Cannot tell whether ${found.recordFormKey} names a Papyrus script here.`, errorMessage(error));
      return undefined;
    }
    return { name: text.slice(found.start + 1, found.end - 1), start: found.start + 1, end: found.end - 1 };
  };

  const references = scriptReferences({ client, open: openPluginSourceDocument, readText: readHeldText });
  const fileOf = ({ source, compiled }: PapyrusScript): string | undefined => source ?? compiled;

  return {
    async nameAt(document, offset) {
      const found = await nameAt(document, offset);
      return found && { start: found.start, end: found.end, spelled: found.name, symbol: { kind: 'script', name: found.name } };
    },
    /** Its source, else its compiled script. */
    definitionOf({ name }): Promise<Definition> {
      const held = scripts().find((script) => sameName(script.name, name));
      const file = held && fileOf(held);
      return Promise.resolve(file === undefined ? { refused: `No mod, Overwrite or the Data folder holds a source or a compiled script of ${name}.` } : { file });
    },
    /** Each member of a record that names it. */
    async referencesTo({ name }) {
      const { found, unread } = await references.read(name);
      return { locations: found, unread };
    },
    /** Its name, since a script has no row. */
    hoverOf: ({ spelled }) => Promise.resolve([spelled]),
    async completionsAt(document, offset) {
      const found = await nameAt(document, offset);
      return found && { start: found.start, end: found.end, icon: vscode.CompletionItemKind.Class, items: scripts().map(({ name }) => ({ label: name })) };
    },
    /** Each script whose name holds `query`, at its source, else its compiled script. */
    symbolsFor(query) {
      const wanted = query.trim().toLowerCase();
      if (wanted === '') return Promise.resolve([]);
      return Promise.resolve(scripts().filter(({ name }) => name.toLowerCase().includes(wanted)).flatMap((script) => {
        const file = fileOf(script);
        return file === undefined ? [] : [{ name: script.name, detail: 'Papyrus script', icon: vscode.SymbolKind.Class, location: atFile(file) }];
      }));
    },
  };
}

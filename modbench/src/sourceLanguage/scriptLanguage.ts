import * as vscode from 'vscode';
import type { MEditClient } from '../client';
import type { InstanceValue, PapyrusScript } from '../instanceLoader/instance';
import { isPluginSourcePath } from '../instanceAdapter/instanceAdapter';
import { errorMessage } from '../ports/errorMessage';
import type { Reporter } from '../ports/reporter';
import { sameName } from '../symbolNames/symbolNames';
import { heldText } from '../textDocuments/heldText';
import { openPluginSourceDocument } from '../textDocuments/pluginSource';
import type { RecordDocumentClient } from '../textDocuments/recordDocument';
import { failureReason, isReadFailed } from '../wire/readFailed';
import { fieldOfRecord } from './fieldMetadata';
import { MEDIT_READS } from './scriptRename';
import { locateCopies, locationOf } from './recordLocation';
import { fieldAt, formKeyAt, formKeyValue, stringsAt } from './sourceText';
import { reportedForFeature, type AskedIn } from './symbolPlaces';

export type ScriptClient = Pick<MEditClient, 'getComparison' | 'getScriptReferences'> & RecordDocumentClient;

interface ScriptLanguageDeps {
  instance: { readonly value: Pick<InstanceValue, 'papyrusScripts'> } | undefined;
  reporter: Pick<Reporter, 'shownOnSurface' | 'report'>;
  client: ScriptClient;
}

const atFile = (file: string): vscode.Location => new vscode.Location(vscode.Uri.file(file), new vscode.Range(0, 0, 0, 0));

/** A Papyrus script as a symbol in the text editor: where plugin source names one a record attaches, and the records
 *  that attach it, which mEdit answers (symbols.md). */
export function scriptLanguage({ instance, reporter, client }: ScriptLanguageDeps) {
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

  const referencesTo = async (name: string): Promise<vscode.Location[]> => {
    const copies = await client.getScriptReferences(name);
    if (isReadFailed(copies)) return reportedForFeature(reporter, name, { found: [], unread: [`${MEDIT_READS}: ${failureReason(copies)}`] }).found;
    const { found, leftOut } = await locateCopies(client, copies, async (copy, uri) => {
      const document = await openPluginSourceDocument(uri);
      const text = heldText(document);
      const spans = stringsAt(text, copy.formKey, copy.fieldPaths);
      return (spans.length > 0 ? spans : [formKeyValue(text, copy.formKey) ?? { start: 0, end: 0 }]).map((span) => locationOf({ uri, document, ...span }));
    });
    return reportedForFeature(reporter, name, { found: found.flat(), unread: leftOut }).found;
  };

  return {
    /** Go to Definition on the script whose name is at `offset`: its source, else its compiled script. Undefined where no
     *  script's name is. */
    definitionAt: async (document: AskedIn, offset: number): Promise<{ start: number; end: number; file: string | undefined } | undefined> => {
      const found = await nameAt(document, offset);
      if (found === undefined) return undefined;
      const file = scripts().find((script) => sameName(script.name, found.name))?.file;
      if (file === undefined) {
        reporter.shownOnSurface('warning', `Go to Definition cannot go to ${found.name}.`, `No mod and no Overwrite holds a source or a compiled script of ${found.name}.`);
      }
      return { start: found.start, end: found.end, file };
    },
    /** What a hover on the script's name at `offset` says: its name, since a script has no row. */
    hoverAt: async (document: AskedIn, offset: number): Promise<{ start: number; end: number; lines: readonly string[] } | undefined> => {
      const found = await nameAt(document, offset);
      return found && { start: found.start, end: found.end, lines: [found.name] };
    },
    /** Completion where plugin source names a script: each script, over the name so far. */
    completionsAt: async (document: AskedIn, offset: number): Promise<{ start: number; end: number; items: readonly string[] } | undefined> => {
      const found = await nameAt(document, offset);
      return found && { start: found.start, end: found.end, items: scripts().map(({ name }) => name) };
    },
    /** Go to Symbol in Workspace: each script whose name holds `query`, at its source, else its compiled script. */
    symbolsFor: (query: string): { name: string; location: vscode.Location }[] => {
      const wanted = query.trim().toLowerCase();
      if (wanted === '') return [];
      return scripts().filter(({ name }) => name.toLowerCase().includes(wanted)).map(({ name, file }) => ({ name, location: atFile(file) }));
    },
    /** Find All References on the script whose name is at `offset`: each member of a record that names it; undefined
     *  where no script's name is. */
    referencesAt: async (document: AskedIn, offset: number): Promise<vscode.Location[] | undefined> => {
      const found = await nameAt(document, offset);
      return found && await referencesTo(found.name);
    },
  };
}

import * as vscode from 'vscode';
import type { MEditClient } from '../client';
import type { InstanceValue, PapyrusScript } from '../instanceLoader/instance';
import { isPluginSourcePath } from '../instanceAdapter/instanceAdapter';
import { errorMessage } from '../ports/errorMessage';
import type { Reporter } from '../ports/reporter';
import { sameName } from '../symbolNames/symbolNames';
import { heldText } from '../textDocuments/heldText';
import { openPluginSourceDocument, readHeldText } from '../textDocuments/pluginSource';
import { fieldOfRecord } from './fieldMetadata';
import { scriptReferences, type ScriptReferencesClient } from './scriptReferences';
import { fieldAt, formKeyAt } from './sourceText';
import { reportedForFeature, type AskedIn } from './symbolPlaces';

export type ScriptClient = Pick<MEditClient, 'getComparison'> & ScriptReferencesClient;

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

  const references = scriptReferences({ client, open: openPluginSourceDocument, readText: readHeldText });
  const fileOf = ({ source, compiled }: PapyrusScript): string | undefined => source ?? compiled;

  return {
    /** Go to Definition on the script whose name is at `offset`: its source, else its compiled script. Undefined where no
     *  script's name is. */
    definitionAt: async (document: AskedIn, offset: number): Promise<{ start: number; end: number; file: string | undefined } | undefined> => {
      const found = await nameAt(document, offset);
      if (found === undefined) return undefined;
      const held = scripts().find((script) => sameName(script.name, found.name));
      const file = held && fileOf(held);
      if (file === undefined) {
        reporter.shownOnSurface('warning', `Go to Definition cannot go to ${found.name}.`, `No mod, Overwrite or the Data folder holds a source or a compiled script of ${found.name}.`);
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
      return scripts().filter(({ name }) => name.toLowerCase().includes(wanted))
        .flatMap((script) => { const file = fileOf(script); return file === undefined ? [] : [{ name: script.name, location: atFile(file) }]; });
    },
    /** Find All References on the script whose name is at `offset`: each member of a record that names it; undefined
     *  where no script's name is. */
    referencesAt: async (document: AskedIn, offset: number): Promise<vscode.Location[] | undefined> => {
      const found = await nameAt(document, offset);
      return found && reportedForFeature(reporter, found.name, await references.read(found.name)).found;
    },
  };
}

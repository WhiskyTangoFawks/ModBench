import * as vscode from 'vscode';
import type { MEditClient } from '../client';
import type { Reporter } from '../ports/reporter';
import type { CopyAt } from '../instanceLoader/fileConflictIndex';
import type { InstanceValue, PapyrusScript } from '../instanceLoader/instance';
import { sameName, type ScriptSymbol } from '../symbolNames/symbolNames';
import { heldText } from '../textDocuments/heldText';
import { membersNaming } from './memberReferences';
import type { SourceNames } from './sourceNames';
import { holdsCopy, type FileCopies } from './fileLanguage';
import { listedAtCopy, nameHolds, showReferencedBy, type AskedIn } from './symbolPlaces';
import type { Definition, References, SymbolKind } from './symbolKind';

export type ScriptClient = Pick<MEditClient, 'getPlacedScriptReferences'>;

interface ScriptLanguageDeps extends FileCopies {
  instance: { readonly value: ScriptsValue } | undefined;
  names: Pick<SourceNames, 'scriptAt' | 'scriptsIn' | 'scriptsNamed'>;
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
export function scriptLanguage({ instance, names, client, reporter, copyOf, reveal }: ScriptLanguageDeps): SymbolKind<ScriptSymbol> & Required<Pick<SymbolKind<ScriptSymbol>, 'namesNothingIn' | 'filesNamingNothing'>> {
  const scripts = (): readonly PapyrusScript[] => instance?.value.papyrusScripts ?? [];

  // Ready to judge; stopped for a reason that lasts, told once; or waiting for a place to answer.
  let toldWhy: string | undefined;
  const standing = (): 'ready' | 'stopped' | 'waiting' => {
    const unjudged = unjudgedBecause(instance?.value);
    if (unjudged?.reason !== undefined && unjudged.reason !== toldWhy) {
      reporter.shownOnSurface('warning', 'The Problems panel does not check the scripts plugin source names.', unjudged.reason);
    }
    toldWhy = unjudged?.reason;
    if (unjudged === undefined) return 'ready';
    return unjudged.reason === undefined ? 'waiting' : 'stopped';
  };
  // The same files while the names and the instance value are the same objects.
  let listed: { named: readonly object[]; value: object | undefined; files: string[] } | undefined;
  const isHeld = (name: string): boolean => scripts().some((script) => sameName(script.name, name));

  const nameAt = (document: AskedIn, offset: number, token?: vscode.CancellationToken) => names.scriptAt(document.uri.fsPath, heldText(document), offset, token);

  const definitionAt = ({ sourceDataPath, compiledDataPath }: PapyrusScript): CopyAt | { none: string } => {
    const source = sourceDataPath === undefined ? undefined : copyOf(sourceDataPath);
    return source !== undefined && holdsCopy(source) ? source : copyOf(compiledDataPath);
  };

  const referencesTo = async ({ name }: ScriptSymbol, token?: vscode.CancellationToken): Promise<References> => {
    const { found, unread } = membersNaming(await client.getPlacedScriptReferences(name, token));
    return { locations: found, unread };
  };

  return {
    async nameAt(document, offset, token) {
      const found = await nameAt(document, offset, token);
      return found && { start: found.start, end: found.end, name: found.name, symbol: { kind: 'script', name: found.name } };
    },
    /** Its source, else the copy of its compiled script the game gets, inside its archive when archived. */
    definitionOf({ name }): Promise<Definition> {
      const held = scripts().find((script) => sameName(script.name, name));
      if (held === undefined) return Promise.resolve({ refused: `No mod, Overwrite or the Data folder holds a source or a compiled script of ${name}.` });
      const at = definitionAt(held);
      if (!holdsCopy(at)) return Promise.resolve({ refused: at.none });
      return Promise.resolve(at.kind === 'loose' ? { file: at.path } : { shown: at });
    },
    /** Each member of a record that names it. */
    referencesTo,
    referencedBy: (script) => showReferencedBy({
      reporter, subject: script.name, contextValue: 'modbench.scriptReferencedBy', references: () => referencesTo(script),
    }),
    /** Each script plugin source names that nothing holds; none where judging has stopped, and undefined where nothing
     *  can be said yet. Nothing is asked of mEdit in either. */
    async namesNothingIn(document) {
      const now = standing();
      if (now !== 'ready') return now === 'stopped' ? [] : undefined;
      return (await names.scriptsIn(document.uri.fsPath, heldText(document))).filter(({ name }) => !isHeld(name))
        .map(({ start, end, name }) => ({ start, end, name, why: `No mod, Overwrite, Data folder file or archive holds ${name}.` }));
    },
    /** Each file plugin source holds that names a script nothing holds, under the same answers. */
    async filesNamingNothing(only) {
      const now = standing();
      if (now !== 'ready') return now === 'stopped' ? [] : undefined;
      const named = await names.scriptsNamed(only);
      if (named === undefined) return undefined;
      const value = instance?.value;
      if (listed?.named !== named || listed.value !== value) listed = { named, value, files: [...new Set(named.filter(({ name }) => !isHeld(name)).map(({ file }) => file))] };
      return listed.files;
    },
    /** None: a script has no row. */
    tooltipOf: () => Promise.resolve([]),
    async completionsAt(document, offset) {
      const found = await nameAt(document, offset);
      return found && { start: found.start, end: found.end, icon: vscode.CompletionItemKind.Class, items: scripts().map(({ name }) => ({ label: name })) };
    },
    /** Each script whose name holds `query`, at its source, else the copy of its compiled script the game gets. */
    symbolsFor(query) {
      return Promise.resolve(scripts().filter(({ name }) => nameHolds(name, query)).flatMap((script) => {
        const at = definitionAt(script);
        return holdsCopy(at) ? [{ symbol: { kind: 'script', name: script.name } as const, name: script.name, detail: 'Papyrus script', icon: vscode.SymbolKind.Class, ...listedAtCopy(at, reveal) }] : [];
      }));
    },
  };
}

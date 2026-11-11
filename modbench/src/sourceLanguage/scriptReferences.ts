import * as vscode from 'vscode';
import type { MEditClient } from '../client';
import { COMMITTED, heldTextAt, sameName, spliced, type EntryOwner, type ScriptSymbol } from '../symbolNames/symbolNames';
import { CONTAINER_SCHEMES, type RecordDocumentClient } from '../textDocuments/recordDocument';
import { pluginAddressKey, type PluginAddress } from '../wire/pluginAddress';
import { copiesNamingAtMembers, membersNaming } from './memberReferences';
import { locateCopies } from './recordLocation';
import { stringsAt, type TextSpan } from './sourceText';

export type ScriptReferencesClient = Pick<MEditClient, 'getScriptReferences'> & RecordDocumentClient;

interface ScriptReferencesDeps {
  readonly client: ScriptReferencesClient;
  readonly open: (uri: vscode.Uri) => PromiseLike<vscode.TextDocument>;
  /** A plugin source file's text, unsaved or saved. */
  readonly readText: (path: string) => Promise<string>;
}

const copyNamed = ({ formKey, plugin }: { formKey: string; plugin: { name: string; origin: string } }): string => `${formKey} in ${plugin.name} (${plugin.origin})`;

/** The records that attach a Papyrus script, which mEdit answers, at the member of each that names it (ADR-0028): what
 *  Find All References lists, and plugin source's part of a rename. */
export function scriptReferences({ client, open, readText }: ScriptReferencesDeps) {
  const copiesAttaching = async (name: string) => copiesNamingAtMembers(await client.getScriptReferences(name));

  // The native Source Control panel misses a working-tree change on its own.
  const owner = (refreshSourceControlFor: (plugin: PluginAddress) => void): EntryOwner<ScriptSymbol> => ({
    async plan({ name }, newName, held) {
      const { copies, unread } = await copiesAttaching(name);
      const { found, leftOut } = await locateCopies(client, copies.filter(({ inPluginSource }) => inPluginSource), async (copy, uri) => {
        if (!CONTAINER_SCHEMES.has(uri.scheme)) throw new Error('its plugin source holds no file of it');
        const text = heldTextAt(held, uri.fsPath) ?? await readText(uri.fsPath);
        const spans = stringsAt(text, copy.formKey, copy.fieldPaths).filter(({ value }) => sameName(value, name));
        if (spans.length < copy.fieldPaths.length) throw new Error(`its plugin source does not name ${name} at ${copy.fieldPaths.join(', ')}`);
        return { path: uri.fsPath, text, spans, plugin: copy.plugin };
      });
      const byPath = new Map<string, { text: string; spans: TextSpan[] }>();
      for (const { path, text, spans } of found) byPath.set(path, { text, spans: [...byPath.get(path)?.spans ?? [], ...spans] });
      const edited = new Map(found.map(({ plugin }) => [pluginAddressKey(plugin), plugin]));
      return {
        changes: { moves: [], deletions: [], documents: [...byPath].map(([path, { text, spans }]) => ({ path, text: spliced(text, spans, () => newName) })) },
        cannotFollow: [...copies.filter(({ inPluginSource }) => !inPluginSource).map(copyNamed), ...unread, ...leftOut],
        commit: () => {
          for (const plugin of edited.values()) refreshSourceControlFor(plugin);
          return Promise.resolve(COMMITTED);
        },
      };
    },
  });

  return {
    /** Plugin source's part of a rename. */
    owner,
    /** Each member of a record that names `name`, at its document, and why each copy that may name it went unread. */
    read: async (name: string): Promise<{ found: vscode.Location[]; unread: string[] }> =>
      membersNaming(client, open, await client.getScriptReferences(name)),
  };
}

import { errorMessage } from '../ports/errorMessage';
import { COMMITTED, heldTextAt, sameName, spliced, type EntryOwner, type ScriptSymbol, type TextSpan } from '../symbolNames/symbolNames';
import { pluginAddressKey, type PluginAddress } from '../wire/pluginAddress';
import { holdsNoCopy } from '../wire/recordCopy';
import { failureReason, isReadFailed } from '../wire/readFailed';
import type { MEditClient } from './MEditClient';

type ScriptSourceClient =Pick<MEditClient, 'getScriptReferences' | 'getCopyDocument' | 'getPluginSourceNames'>;

interface ScriptSourceRenameDeps {
  readonly client: ScriptSourceClient;
  /** A plugin source file's text, unsaved or saved. */
  readonly readText: (path: string) => Promise<string>;
  /** The native Source Control panel misses a working-tree change on its own. */
  readonly refreshSourceControlFor: (plugin: PluginAddress) => void;
}

type Copy = { readonly formKey: string; readonly plugin: PluginAddress };

const copyNamed = ({ formKey, plugin }: Copy): string => `${formKey} in ${plugin.name} (${plugin.origin})`;

/** Plugin source's part in renaming a Papyrus script: each member of a record that attaches it, as mEdit answers them
 *  (ADR-0028). */
export function scriptSourceRename({ client, readText, refreshSourceControlFor }: ScriptSourceRenameDeps): EntryOwner<ScriptSymbol> {
  const fileOf = async (copy: Copy): Promise<string | { why: string }> => {
    const document = await client.getCopyDocument(copy.plugin, copy.formKey);
    if (isReadFailed(document)) return { why: failureReason(document) };
    if (document === null) return { why: holdsNoCopy(copy) };
    if (document.kind === 'Rendered') throw new Error('its plugin source holds no file of it');
    return document.location;
  };

  return {
    async plan({ name }, newName, held) {
      const answer = await client.getScriptReferences(name);
      const { copies, unread } = isReadFailed(answer) ? { copies: [], unread: [`the plugins mEdit reads: ${failureReason(answer)}`] } : answer;
      const located = await Promise.all(copies.filter(({ inPluginSource }) => inPluginSource).map(async (copy) => {
        try {
          const path = await fileOf(copy);
          if (typeof path !== 'string') return path;
          const text = heldTextAt(held, path) ?? await readText(path);
          const names = await client.getPluginSourceNames(text, path);
          if (isReadFailed(names)) throw new Error(failureReason(names));
          const spans = names.filter((named) => named.kind === 'Script' && named.record === copy.formKey
            && copy.fieldPaths.includes(named.fieldPath ?? '') && sameName(named.value, name));
          if (spans.length < copy.fieldPaths.length) throw new Error(`its plugin source does not name ${name} at ${copy.fieldPaths.join(', ')}`);
          return { path, text, spans, plugin: copy.plugin };
        } catch (error) {
          return { why: `${copyNamed(copy)}: ${errorMessage(error)}` };
        }
      }));
      const found = located.flatMap((each) => ('why' in each ? [] : [each]));
      const byPath = new Map<string, { text: string; spans: TextSpan[] }>();
      for (const { path, text, spans } of found) byPath.set(path, { text, spans: [...byPath.get(path)?.spans ?? [], ...spans] });
      const edited = new Map(found.map(({ plugin }) => [pluginAddressKey(plugin), plugin]));
      return {
        changes: { moves: [], deletions: [], documents: [...byPath].map(([path, { text, spans }]) => ({ path, text: spliced(text, spans, () => newName) })) },
        cannotFollow: [
          ...copies.filter(({ inPluginSource }) => !inPluginSource).map(copyNamed), ...unread,
          ...located.flatMap((each) => ('why' in each ? [each.why] : [])),
        ],
        commit: () => {
          for (const plugin of edited.values()) refreshSourceControlFor(plugin);
          return Promise.resolve(COMMITTED);
        },
      };
    },
  };
}

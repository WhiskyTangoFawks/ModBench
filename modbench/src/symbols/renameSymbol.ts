import type { MEditClient } from '../client';
import type { RecordMember, SourceNames } from './sourceNames';
import { pluginNamed, type PluginSymbol, type ResolvedPlugin, type TextSpan } from '../symbolNames/symbolNames';
import { heldText } from '../textDocuments/heldText';
import type { RecordEditEnvelope } from '../wire/messages';
import { failureReason, isReadFailed } from '../wire/readFailed';
import type { entryLanguage } from './entryLanguage';
import type { pluginLanguage } from './pluginLanguage';
import type { AskedIn } from './symbolPlaces';

interface RenameSymbolDeps {
  readonly plugin: Pick<ReturnType<typeof pluginLanguage>, 'renameRangeAt' | 'renameAt'>;
  readonly entry: Pick<ReturnType<typeof entryLanguage>, 'renameRangeAt' | 'renameAt'>;
  readonly names: Pick<SourceNames, 'recordMemberAt'>;
  readonly plugins: () => readonly ResolvedPlugin[];
  readonly client: Pick<MEditClient, 'getRecordOfFile'>;
  readonly executeCommand: (command: string, ...args: unknown[]) => PromiseLike<unknown>;
}

/** Rename Symbol: on a plugin's name, the plugin's `rename`; on a mod's or a separator's, its `rename`; on a FormKey or an EditorID in plugin source, `edit
 *  field` on it (symbols.md, The symbols, Record). */
export function renameSymbol({ plugin, entry, names, plugins, client, executeCommand }: RenameSymbolDeps) {
  const recordNamedAt = (document: AskedIn, offset: number): Promise<RecordMember | undefined> =>
    names.recordMemberAt(document.uri.fsPath, heldText(document), offset);

  // An EditorID is the label of the copy its file holds.
  async function copyEdited(record: RecordMember, path: string): Promise<PluginSymbol> {
    if (record.member === 'FormKey') {
      const resolved = pluginNamed(record.plugin, plugins());
      if (resolved === undefined) throw new Error(`Mod order resolves ${record.plugin.name} to no plugin.`);
      return resolved;
    }
    const held = await client.getRecordOfFile(path);
    if (isReadFailed(held)) throw new Error(failureReason(held));
    if (held === null) throw new Error('mEdit says this file holds no record.');
    return held.plugin;
  }

  return {
    /** The span Rename Symbol offers, and the name it shows there. */
    async prepare(document: AskedIn, offset: number): Promise<TextSpan & { placeholder: string }> {
      const named = await plugin.renameRangeAt(document, offset) ?? await entry.renameRangeAt(document, offset);
      if (named !== undefined) return { start: named.start, end: named.end, placeholder: named.name };
      const record = await recordNamedAt(document, offset);
      if (record === undefined) throw new Error('Rename Symbol renames a plugin, a mod or a separator, or changes a record\'s FormKey or EditorID, and none is here.');
      return { start: record.start, end: record.end, placeholder: heldText(document).slice(record.start, record.end) };
    },
    async rename(document: AskedIn, offset: number, newName: string): Promise<void> {
      if (await plugin.renameRangeAt(document, offset) !== undefined) {
        await plugin.renameAt(document, offset, newName);
        return;
      }
      if (await entry.renameRangeAt(document, offset) !== undefined) {
        await entry.renameAt(document, offset, newName);
        return;
      }
      const record = await recordNamedAt(document, offset);
      if (record === undefined) return;
      const copy = await copyEdited(record, document.uri.fsPath);
      const envelope: RecordEditEnvelope = { op: 'set', path: [{ kind: 'member', name: record.member }], value: newName };
      await executeCommand('modbench.record.editField', { formKey: record.formKey, plugin: copy.name, origin: copy.origin }, envelope);
    },
  };
}

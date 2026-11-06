import type { MEditClient } from '../client';
import { isPluginSourcePath } from '../instanceAdapter/instanceAdapter';
import { pluginNamed, type PluginSymbol, type ResolvedPlugin } from '../symbolNames/symbolNames';
import { heldText } from '../textDocuments/heldText';
import type { RecordEditEnvelope } from '../wire/messages';
import { failureReason, isReadFailed } from '../wire/readFailed';
import type { pluginLanguage } from './pluginLanguage';
import { fieldAt, formKeyAt, pluginNameIn, type TextSpan } from './sourceText';
import type { AskedIn } from './symbolPlaces';

interface RenameSymbolDeps {
  readonly plugin: Pick<ReturnType<typeof pluginLanguage>, 'renameRangeAt' | 'renameAt'>;
  readonly plugins: () => readonly ResolvedPlugin[];
  readonly client: Pick<MEditClient, 'getRecordOfFile'>;
  readonly executeCommand: (command: string, ...args: unknown[]) => PromiseLike<unknown>;
}

interface RecordNamed extends TextSpan {
  readonly formKey: string;
  readonly member: 'FormKey' | 'EditorID';
}

const between = ({ start, end }: TextSpan): TextSpan => ({ start: start + 1, end: end - 1 });

function recordNamedAt(document: AskedIn, offset: number): RecordNamed | undefined {
  if (!isPluginSourcePath(document.uri.fsPath)) return undefined;
  const text = heldText(document);
  const formKey = formKeyAt(text, offset);
  if (formKey) return { ...between(formKey), formKey: formKey.formKey, member: 'FormKey' };
  const field = fieldAt(text, offset);
  return field?.path.length === 1 && field.path[0] === 'EditorID' ? { ...between(field), formKey: field.recordFormKey, member: 'EditorID' } : undefined;
}

/** Rename Symbol: on a plugin's name, the plugin's `rename`; on a FormKey or an EditorID in plugin source, `edit
 *  field` on it (source.md, In the text editor). */
export function renameSymbol({ plugin, plugins, client, executeCommand }: RenameSymbolDeps) {
  // A FormKey names its plugin by its file name alone; an EditorID is the label of the copy its file holds.
  async function copyEdited(record: RecordNamed, path: string): Promise<PluginSymbol> {
    if (record.member === 'FormKey') {
      const name = pluginNameIn(record.formKey);
      const resolved = pluginNamed({ name }, plugins());
      if (resolved === undefined) throw new Error(`Mod order resolves ${name} to no plugin.`);
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
      const named = await plugin.renameRangeAt(document, offset);
      if (named !== undefined) return { start: named.start, end: named.end, placeholder: named.name };
      const record = recordNamedAt(document, offset);
      if (record === undefined) throw new Error('Rename Symbol renames a plugin, or changes a record\'s FormKey or EditorID, and none is here.');
      return { start: record.start, end: record.end, placeholder: heldText(document).slice(record.start, record.end) };
    },
    async rename(document: AskedIn, offset: number, newName: string): Promise<void> {
      const record = await plugin.renameRangeAt(document, offset) === undefined ? recordNamedAt(document, offset) : undefined;
      if (record === undefined) {
        await plugin.renameAt(document, offset, newName);
        return;
      }
      const copy = await copyEdited(record, document.uri.fsPath);
      const envelope: RecordEditEnvelope = { op: 'set', path: [{ kind: 'member', name: record.member }], value: newName };
      await executeCommand('modbench.record.editField', { formKey: record.formKey, plugin: copy.name, origin: copy.origin }, envelope);
    },
  };
}

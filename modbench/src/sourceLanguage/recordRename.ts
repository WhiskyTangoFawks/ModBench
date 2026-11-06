import { pluginNamed, type PluginSymbol, type ResolvedPlugin } from '../symbolNames/symbolNames';
import type { RecordEditEnvelope } from '../wire/messages';
import { fieldAt, formKeyAt, type TextSpan } from './sourceText';

type EditFieldArguments = [address: { formKey: string; plugin: string; origin: string }, envelope: RecordEditEnvelope];

interface RecordEdit extends TextSpan {
  readonly value: string;
  /** The arguments of `edit field` that set the value to `newName`. */
  edit(newName: string, plugins: readonly ResolvedPlugin[], copyOfFile: () => Promise<PluginSymbol | undefined>): Promise<EditFieldArguments>;
}

const PLUGIN_NAME_OFFSET = 7;

const envelope = (member: 'FormKey' | 'EditorID', value: string): RecordEditEnvelope => ({ op: 'set', path: [{ kind: 'member', name: member }], value });

/** The FormKey or the EditorID at `offset`, which Rename Symbol sets through `edit field`; undefined where neither is.
 *  A FormKey names its plugin by its file name alone, so its change goes to the copy mod order resolves it to. */
export function recordEditAt(text: string, offset: number): RecordEdit | undefined {
  const formKey = formKeyAt(text, offset);
  if (formKey) {
    const span = { start: formKey.start + 1, end: formKey.end - 1 };
    return {
      ...span,
      value: text.slice(span.start, span.end),
      edit: (newName, plugins) => {
        const name = formKey.formKey.slice(PLUGIN_NAME_OFFSET);
        const native = pluginNamed({ name }, plugins);
        if (native === undefined) return Promise.reject(new Error(`Mod order resolves ${name} to no plugin.`));
        return Promise.resolve([{ formKey: formKey.formKey, plugin: native.name, origin: native.origin }, envelope('FormKey', newName)]);
      },
    };
  }
  const field = fieldAt(text, offset);
  if (field?.path.length !== 1 || field.path[0] !== 'EditorID') return undefined;
  const span = { start: field.start + 1, end: field.end - 1 };
  return {
    ...span,
    value: text.slice(span.start, span.end),
    edit: async (newName, _plugins, copyOfFile) => {
      const copy = await copyOfFile();
      if (copy === undefined) throw new Error('mEdit says this file holds no record.');
      return [{ formKey: field.recordFormKey, plugin: copy.name, origin: copy.origin }, envelope('EditorID', newName)];
    },
  };
}

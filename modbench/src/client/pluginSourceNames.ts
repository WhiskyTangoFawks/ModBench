import { errorMessage } from '../ports/errorMessage';
import type { Reporter } from '../ports/reporter';
import type { PluginName, TextSpan } from '../symbolNames/symbolNames';
import { answerOf, failureReason, isReadFailed } from '../wire/readFailed';
import { fieldOfRecord, recordTypeOfPathField, type ComparisonClient, type metadataAt } from './fieldMetadata';
import type { MEditClient } from './MEditClient';
import { fieldAt, fieldPathOf, formKeyAt, formKeyPluginAt, pluginNameIn, type FieldAtOffset } from './pluginSourceText';

export type PluginSourceClient = ComparisonClient & Pick<MEditClient, 'searchRecords' | 'resolveFilePath'>;

interface PluginSourceNamesDeps {
  client: PluginSourceClient;
  reporter: Pick<Reporter, 'shownOnSurface'>;
  /** Whether the file at `path` is plugin source. */
  isPluginSource: (path: string) => boolean;
  gameRelease: () => Promise<string>;
}

type FieldMetadata = NonNullable<ReturnType<typeof metadataAt>>;

interface RecordsOffered extends TextSpan {
  readonly items: readonly { readonly label: string; readonly detail: string; readonly insertText: string }[];
}

/** A FormKey, with the plugin it names, or an EditorID in plugin source, which Rename Symbol changes on its record. */
export type RecordMember = TextSpan & { readonly formKey: string } & (
  | { readonly member: 'FormKey'; readonly plugin: PluginName }
  | { readonly member: 'EditorID' });

/** The file a path in plugin source names, by its path in the Data folder, or why it names none. */
export type NamedFile = TextSpan & { readonly given: string } & ({ readonly path: string } | { readonly refused: string });

const between = ({ start, end }: TextSpan): TextSpan => ({ start: start + 1, end: end - 1 });

async function referenceCompletions(client: PluginSourceClient, field: FieldMetadata, typed: string, range: TextSpan): Promise<RecordsOffered | undefined> {
  if (!typed) return undefined;
  const { items } = answerOf(await client.searchRecords(typed, field.validFormKeyTypes));
  const records = [...new Map(items.map((record) => [record.formKey, record])).values()];
  return { ...range, items: records.map(({ editorId, formKey }) => ({ label: editorId || formKey, detail: formKey, insertText: formKey })) };
}

/** The names plugin source holds, and where each sits, as mEdit's record index answers them (target-architecture.md),
 *  in the text the caller hands it. A file that is no plugin source names nothing here. */
export function pluginSourceNames({ client, reporter, isPluginSource, gameRelease }: PluginSourceNamesDeps) {
  const sourceFieldAt = (file: string, text: string, offset: number): FieldAtOffset | undefined =>
    (isPluginSource(file) ? fieldAt(text, offset) : undefined);

  // A FormKey is a record's name, never a script's or a file's.
  const valueAt = (file: string, text: string, offset: number): FieldAtOffset | undefined => {
    const found = sourceFieldAt(file, text, offset);
    return found && formKeyAt(text, offset) === undefined ? found : undefined;
  };

  return {
    /** The record whose FormKey is under `offset`, spanning the string with its quotes. */
    recordAt: (file: string, text: string, offset: number): (TextSpan & { formKey: string }) | undefined =>
      (isPluginSource(file) ? formKeyAt(text, offset) : undefined),

    /** The plugin whose name is under `offset`, inside a FormKey, by its file name alone. */
    pluginAt: (file: string, text: string, offset: number): Promise<PluginName | undefined> => {
      const found = isPluginSource(file) ? formKeyPluginAt(text, offset) : undefined;
      return Promise.resolve(found && { name: found.name });
    },

    /** The Papyrus script a record attaches whose name is under `offset`, spanning its name between its quotes. */
    async scriptAt(file: string, text: string, offset: number): Promise<(TextSpan & { name: string }) | undefined> {
      const found = valueAt(file, text, offset);
      if (found === undefined || found.end - found.start <= 2) return undefined;
      try {
        if (!(await fieldOfRecord(client, found))?.isScriptName) return undefined;
      } catch (error) {
        reporter.shownOnSurface('error', `Cannot tell whether ${found.recordFormKey} names a Papyrus script here.`, errorMessage(error));
        return undefined;
      }
      return { ...between(found), name: text.slice(found.start + 1, found.end - 1) };
    },

    /** The file a record's path under `offset` names, as mEdit resolves it, spanning the path between its quotes. */
    async fileAt(file: string, text: string, offset: number): Promise<NamedFile | undefined> {
      const found = valueAt(file, text, offset);
      if (found === undefined) return undefined;
      try {
        const recordType = await recordTypeOfPathField(client, found);
        const given: unknown = JSON.parse(text.slice(found.start, found.end));
        if (recordType === undefined || typeof given !== 'string') return undefined;
        const path = await client.resolveFilePath(await gameRelease(), recordType, JSON.stringify(found.record), fieldPathOf(found.path));
        return { ...between(found), given, ...isReadFailed(path) ? { refused: failureReason(path) } : { path } };
      } catch (error) {
        reporter.shownOnSurface('error', `Cannot tell whether ${found.recordFormKey} names a file here.`, errorMessage(error));
        return undefined;
      }
    },

    /** The records a reference field under `offset` offers for the text typed so far, over the string between its
     *  quotes; undefined elsewhere, and where mEdit cannot answer, which the Output says. */
    async recordsOfferedAt(file: string, text: string, offset: number): Promise<RecordsOffered | undefined> {
      const found = sourceFieldAt(file, text, offset);
      if (!found || offset <= found.start) return undefined;
      try {
        const field = await fieldOfRecord(client, found);
        const range = between(found);
        return field?.type === 'formKey' ? await referenceCompletions(client, field, text.slice(range.start, offset), range) : undefined;
      } catch (error) {
        reporter.shownOnSurface('error', `Completion cannot list what ${found.recordFormKey} offers here.`, errorMessage(error));
        return undefined;
      }
    },

    /** The FormKey or the EditorID under `offset`, between its quotes. */
    recordMemberAt(file: string, text: string, offset: number): RecordMember | undefined {
      if (!isPluginSource(file)) return undefined;
      const formKey = formKeyAt(text, offset);
      if (formKey) return { ...between(formKey), formKey: formKey.formKey, member: 'FormKey', plugin: { name: pluginNameIn(formKey.formKey) } };
      const field = fieldAt(text, offset);
      return field?.path.length === 1 && field.path[0] === 'EditorID' ? { ...between(field), formKey: field.recordFormKey, member: 'EditorID' } : undefined;
    },
  };
}

export type PluginSourceNames = ReturnType<typeof pluginSourceNames>;

import type { DocumentName, MEditClient } from '../client';
import type { SourceFilesOf } from '../instanceLoader/loadOrderSnapshot';
import type { Reporter } from '../ports/reporter';
import { sameName, type PluginName, type TextSpan } from '../symbolNames/symbolNames';
import { answerOf, failureReason, isReadFailed } from '../wire/readFailed';
import { scriptsNamed } from './scriptsNamed';

interface SourceNamesDeps {
  /** What mEdit's record index names in plugin source. */
  names: Pick<MEditClient, 'getPluginSourceNames'>;
  /** What mEdit's record index names across every compiled plugin's source. */
  paths: Pick<MEditClient, 'getPluginFilePaths'>;
  sourceFiles: SourceFilesOf;
  reporter: Pick<Reporter, 'shownOnSurface'>;
}

type AssetType = NonNullable<DocumentName['assetType']>;

/** A FormKey, with the plugin it names, or an EditorID, which Rename Symbol changes on its record. */
export type RecordMember = TextSpan & { readonly formKey: string } & (
  | { readonly member: 'FormKey'; readonly plugin: PluginName }
  | { readonly member: 'EditorID' });

/** The file a path names, by its path in the Data folder, or why it names none. */
export type NamedFile = TextSpan & { readonly given: string } & ({ readonly path: string } | { readonly refused: string });

const NOWHERE: TextSpan = { start: 0, end: 0 };
const OWN = 'FormKey';

const spanOf = ({ start, end }: TextSpan): TextSpan => ({ start, end });

type Typed = TextSpan & { readonly typed: string };

const typedIn = (text: string, found: TextSpan, offset: number): Typed => ({ ...spanOf(found), typed: text.slice(found.start, Math.max(found.start, offset)) });

// mEdit spans a record's FormKey with its quotes, and every other name between them.
const betweenQuotes = ({ start, end }: TextSpan): TextSpan => ({ start: start + 1, end: end - 1 });

/** The names plugin source holds, and where each sits, as mEdit's record index answers them (target-architecture.md).
 *  A place is asked of with its file; a copy's document by its text alone. */
export function sourceNames({ names, paths, sourceFiles, reporter }: SourceNamesDeps) {
  let told: string | undefined;

  // Every kind asks of one place in turn, so a place mEdit cannot answer for is told once.
  const namesAt = async (file: string, text: string, offset: number): Promise<DocumentName[]> => {
    const answer = await names.getPluginSourceNames(text, file, offset);
    if (!isReadFailed(answer)) return answer;
    const place = JSON.stringify([file, offset, text, failureReason(answer)]);
    if (told !== place) reporter.shownOnSurface('error', 'Cannot tell what plugin source names here.', failureReason(answer));
    told = place;
    return [];
  };

  const namesIn = async (text: string): Promise<DocumentName[]> => answerOf(await names.getPluginSourceNames(text));

  const nameAt = async (file: string, text: string, offset: number, kind: DocumentName['kind']): Promise<DocumentName | undefined> =>
    (await namesAt(file, text, offset)).find((name) => name.kind === kind);

  return {
    ...copyDocumentNames(namesIn),
    /** The record whose FormKey is at `offset`, spanning the FormKey with its quotes. */
    async recordAt(file: string, text: string, offset: number): Promise<(TextSpan & { formKey: string }) | undefined> {
      const found = await nameAt(file, text, offset, 'Record');
      return found && { ...spanOf(found), formKey: found.value };
    },

    /** The Papyrus script a record attaches whose name is at `offset`. */
    async scriptAt(file: string, text: string, offset: number): Promise<(TextSpan & { name: string }) | undefined> {
      const found = await nameAt(file, text, offset, 'Script');
      return found && { ...spanOf(found), name: found.value };
    },

    scriptsNamed: scriptsNamed({ paths, sourceFiles, reporter }),

    /** Each Papyrus script a document names, which fails where mEdit cannot answer. */
    async scriptsIn(file: string, text: string): Promise<(TextSpan & { name: string })[]> {
      return answerOf(await names.getPluginSourceNames(text, file))
        .filter(({ kind }) => kind === 'Script')
        .map((found) => ({ ...spanOf(found), name: found.value }));
    },

    /** The file a record's path at `offset` names; undefined at an empty path, which names none. */
    async fileAt(file: string, text: string, offset: number): Promise<NamedFile | undefined> {
      const found = await nameAt(file, text, offset, 'File');
      if (found === undefined || found.value === '') return undefined;
      const given = { ...spanOf(found), given: found.value };
      return found.dataPath ? { ...given, path: found.dataPath } : { ...given, refused: found.refusal ?? `${found.value} names no file.` };
    },

    /** The span of a record's path at `offset`, the text typed in it up to `offset`, and the asset type of its field. */
    async pathTypedAt(file: string, text: string, offset: number): Promise<(Typed & { assetType: AssetType }) | undefined> {
      const found = await nameAt(file, text, offset, 'File');
      return found?.assetType ? { ...typedIn(text, found, offset), assetType: found.assetType } : undefined;
    },

    /** The span of a reference field's text at `offset`, the text typed in it up to `offset`, and the record types it
     *  allows; none where it allows any. */
    async referenceTypedAt(file: string, text: string, offset: number): Promise<(Typed & { types: readonly string[] }) | undefined> {
      const found = await nameAt(file, text, offset, 'Reference');
      return found && { ...typedIn(text, found, offset), types: found.validFormKeyTypes ?? [] };
    },

    /** The FormKey or the EditorID at `offset`, between its quotes. */
    async recordMemberAt(file: string, text: string, offset: number): Promise<RecordMember | undefined> {
      const names = await namesAt(file, text, offset);
      const formKey = names.find((name) => name.kind === 'Record');
      const plugin = formKey && (await namesIn(text)).find((name) => name.kind === 'Plugin' && name.start > formKey.start && name.end < formKey.end);
      if (formKey && plugin) return { ...betweenQuotes(formKey), formKey: formKey.value, member: 'FormKey', plugin: { name: plugin.value } };
      const editorId = names.find((name) => name.kind === 'EditorId');
      return editorId?.record ? { ...spanOf(editorId), formKey: editorId.record, member: 'EditorID' } : undefined;
    },
  };
}

const ownFormKey = (names: readonly DocumentName[], formKey: string): DocumentName | undefined =>
  names.find((name) => name.kind === 'Record' && name.record === formKey && name.fieldPath === OWN);

// A copy's document is asked of by its text alone; one mEdit cannot answer for fails, for its caller to leave out.
function copyDocumentNames(namesIn: (text: string) => Promise<DocumentName[]>) {
  return {
    /** The record `formKey`'s own FormKey member in a copy's document. */
    async declarationIn(text: string, formKey: string): Promise<TextSpan | undefined> {
      const found = (await namesIn(text)).find((name) => name.kind === 'Declaration' && name.record === formKey);
      return found && spanOf(found);
    },

    /** The record `formKey`'s own FormKey, with its quotes, in a copy's document. */
    async formKeyIn(text: string, formKey: string): Promise<TextSpan | undefined> {
      const found = ownFormKey(await namesIn(text), formKey);
      return found && spanOf(found);
    },

    /** Where the record `referrer` references `formKey` in a copy's document: its first reference, else its own FormKey;
     *  the start of the text when the record is absent. */
    async referenceIn(text: string, referrer: string, formKey: string): Promise<TextSpan> {
      const names = await namesIn(text);
      const found = names.find((name) => name.kind === 'Record' && name.record === referrer && name.value === formKey && name.fieldPath !== OWN)
        ?? ownFormKey(names, referrer);
      return found ? spanOf(found) : NOWHERE;
    },

    /** Where the record `formKey` names the plugin `name` in a copy's document: each FormKey of it that names the plugin,
     *  else its own FormKey; the start of the text when the record is absent. */
    async pluginNamesIn(text: string, formKey: string, name: string): Promise<TextSpan[]> {
      const names = await namesIn(text);
      const naming = names.filter((found) => found.kind === 'Plugin' && found.record === formKey && sameName(found.value, name));
      const own = ownFormKey(names, formKey);
      return naming.length > 0 ? naming.map(spanOf) : [own ? spanOf(own) : NOWHERE];
    },

    /** Where the record `formKey` names a script or a file at one of `fieldPaths`, mEdit's member paths, in a copy's
     *  document. */
    async membersIn(text: string, formKey: string, fieldPaths: readonly string[]): Promise<TextSpan[]> {
      const names = await namesIn(text);
      return names
        .filter(({ kind, record, fieldPath }) => (kind === 'Script' || kind === 'File') && record === formKey && fieldPaths.includes(fieldPath ?? ''))
        .map(spanOf);
    },
  };
}

export type SourceNames = ReturnType<typeof sourceNames>;

import type { MEditClient } from '../client';
import { errorMessage } from '../ports/errorMessage';
import type { Reporter } from '../ports/reporter';
import { metadataAt } from './fieldMetadata';
import { fieldAt, type FieldAtOffset } from './sourceText';

interface SourceCompletion {
  label: string;
  detail: string;
  insertText: string;
}

interface SourceCompletions {
  kind: 'reference' | 'enumMember';
  isIncomplete: boolean;
  start: number;
  end: number;
  items: SourceCompletion[];
}

type Client = Pick<MEditClient, 'getComparison' | 'searchRecords'>;
type FieldMetadata = NonNullable<ReturnType<typeof metadataAt>>;
type Range = Pick<SourceCompletions, 'start' | 'end'>;

const enumCompletions = (field: FieldMetadata, range: Range): SourceCompletions => ({
  ...range,
  kind: 'enumMember',
  isIncomplete: false,
  items: field.enumMembers.map(({ value, label }) => ({ label: value, detail: label ?? '', insertText: value })),
});

async function referenceCompletions(client: Client, field: FieldMetadata, typed: string, range: Range): Promise<SourceCompletions | undefined> {
  if (!typed) return undefined;
  const { items } = await client.searchRecords(typed, field.validFormKeyTypes);
  const records = [...new Map(items.map((record) => [record.formKey, record])).values()];
  return {
    ...range,
    kind: 'reference',
    isIncomplete: true,
    items: records.map(({ editorId, formKey }) => ({ label: editorId || formKey, detail: formKey, insertText: formKey })),
  };
}

async function fieldOfRecord(client: Client, found: FieldAtOffset): Promise<FieldMetadata | undefined> {
  const comparison = await client.getComparison(found.recordFormKey);
  const copy = comparison?.overrides.find((candidate) => candidate.isWinner);
  return copy && metadataAt(copy.fields, found.record, found.path);
}

/** What the string under the cursor completes to: the records a reference field offers for the text typed so
 *  far, or the values of an enum field; undefined elsewhere, and where mEdit cannot answer, which the Output says. */
export async function completionsAt(
  { client, reporter }: { client: Client; reporter: Pick<Reporter, 'shownOnSurface'> },
  text: string, offset: number,
): Promise<SourceCompletions | undefined> {
  const found = fieldAt(text, offset);
  if (!found || offset <= found.start) return undefined;
  try {
    const field = await fieldOfRecord(client, found);
    const range = { start: found.start + 1, end: found.end - 1 };
    if (field?.type === 'enum' || field?.type === 'flags') return enumCompletions(field, range);
    if (field?.type === 'formKey') return await referenceCompletions(client, field, text.slice(range.start, offset), range);
    return undefined;
  } catch (error) {
    reporter.shownOnSurface('error', `Completion cannot list what ${found.recordFormKey} offers here.`, errorMessage(error));
    return undefined;
  }
}

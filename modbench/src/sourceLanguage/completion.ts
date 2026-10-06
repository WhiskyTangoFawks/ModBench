import type { MEditClient } from '../client';
import { fieldAtOffset, metadataAt, type FieldAtOffset } from './fieldAtOffset';

export interface SourceCompletion {
  label: string;
  detail: string;
  insertText: string;
}

export interface SourceCompletions {
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
 *  far, or the values of an enum field; undefined elsewhere. */
export async function completionsAt(client: Client, text: string, offset: number): Promise<SourceCompletions | undefined> {
  const found = fieldAtOffset(text, offset);
  if (!found || offset <= found.node.offset) return undefined;
  const field = await fieldOfRecord(client, found);
  const range = { start: found.node.offset + 1, end: found.node.offset + found.node.length - 1 };
  if (field?.type === 'enum' || field?.type === 'flags') return enumCompletions(field, range);
  if (field?.type === 'formKey') return referenceCompletions(client, field, text.slice(range.start, offset), range);
  return undefined;
}

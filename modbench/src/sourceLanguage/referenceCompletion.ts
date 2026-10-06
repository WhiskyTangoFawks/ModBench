import type { MEditClient } from '../client';
import { fieldAtOffset, metadataAt } from './fieldAtOffset';

export interface SourceCompletion {
  label: string;
  detail: string;
  formKey: string;
}

export interface SourceCompletions {
  start: number;
  end: number;
  items: SourceCompletion[];
}

/** The records a reference field offers for the text typed so far in its string; undefined elsewhere. */
export async function completionsAt(
  client: Pick<MEditClient, 'getComparison' | 'searchRecords'>, text: string, offset: number,
): Promise<SourceCompletions | undefined> {
  const found = fieldAtOffset(text, offset);
  const typed = found && text.slice(found.node.offset + 1, offset);
  if (!found || !typed || offset <= found.node.offset) return undefined;
  const comparison = await client.getComparison(found.recordFormKey);
  const copy = comparison?.overrides.find((candidate) => candidate.isWinner);
  const field = copy && metadataAt(copy.fields, found.record, found.path);
  if (field?.type !== 'formKey') return undefined;
  const { items } = await client.searchRecords(typed, field.validFormKeyTypes);
  const records = [...new Map(items.map((record) => [record.formKey, record])).values()];
  return {
    start: found.node.offset + 1,
    end: found.node.offset + found.node.length - 1,
    items: records.map(({ editorId, formKey }) => ({ label: editorId || formKey, detail: formKey, formKey })),
  };
}

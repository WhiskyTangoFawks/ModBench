import type { CompareResult, MEditClient } from '../client';
import { formKeyAt, recordLabel } from './sourceText';

interface SourceHover {
  start: number;
  end: number;
  markdown: string;
}

function markdownOf(formKey: string, comparison: CompareResult): string {
  const winner = comparison.overrides.find((copy) => copy.isWinner);
  return [
    '`' + recordLabel(winner?.editorId, formKey) + '`',
    comparison.recordTypeName,
    ...(winner ? [`Winner: ${winner.plugin}`] : []),
  ].join('\n\n');
}

/** The hover over the FormKey string at `offset` of a plugin source document; undefined where
 *  there is no FormKey, or no active plugin holds it. */
export async function hoverAt(client: Pick<MEditClient, 'getComparison'>, text: string, offset: number): Promise<SourceHover | undefined> {
  const found = formKeyAt(text, offset);
  const comparison = found && await client.getComparison(found.formKey);
  return found && comparison ? { start: found.start, end: found.end, markdown: markdownOf(found.formKey, comparison) } : undefined;
}

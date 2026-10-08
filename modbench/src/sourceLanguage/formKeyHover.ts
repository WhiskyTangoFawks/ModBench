import type { CompareResult, MEditClient } from '../client';
import { errorMessage } from '../ports/errorMessage';
import type { Reporter } from '../ports/reporter';
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
 *  there is no FormKey, no active plugin holds it, or mEdit cannot answer, which the Output says. */
export async function hoverAt(
  { client, reporter }: { client: Pick<MEditClient, 'getComparison'>; reporter: Pick<Reporter, 'shownOnSurface'> },
  text: string, offset: number,
): Promise<SourceHover | undefined> {
  const found = formKeyAt(text, offset);
  if (!found) return undefined;
  try {
    const comparison = await client.getComparison(found.formKey);
    return comparison ? { start: found.start, end: found.end, markdown: markdownOf(found.formKey, comparison) } : undefined;
  } catch (error) {
    reporter.shownOnSurface('error', `Hover cannot describe ${found.formKey}.`, errorMessage(error));
    return undefined;
  }
}

import type { CompareResult, MEditClient } from '../client';
import { errorMessage } from '../ports/errorMessage';
import type { Reporter } from '../ports/reporter';
import { recordLabel } from '../wire/recordLabel';
import { answerOf } from '../wire/readFailed';

function linesOf(formKey: string, comparison: CompareResult): string[] {
  const winner = comparison.overrides.find((copy) => copy.isWinner);
  return [
    '`' + recordLabel(winner?.editorId, formKey) + '`',
    comparison.recordTypeName,
    ...(winner ? [`Winner: ${winner.plugin}`] : []),
  ];
}

/** The hover's lines on the record `formKey` names; undefined where no active plugin holds it, or mEdit cannot answer,
 *  which the Output says. */
export async function hoverOf(
  { client, reporter }: { client: Pick<MEditClient, 'getComparison'>; reporter: Pick<Reporter, 'shownOnSurface'> },
  formKey: string,
  token?: Parameters<MEditClient['getComparison']>[2],
): Promise<string[] | undefined> {
  try {
    const comparison = answerOf(await client.getComparison(formKey, undefined, token));
    return comparison ? linesOf(formKey, comparison) : undefined;
  } catch (error) {
    reporter.shownOnSurface('error', `Hover cannot describe ${formKey}.`, errorMessage(error));
    return undefined;
  }
}

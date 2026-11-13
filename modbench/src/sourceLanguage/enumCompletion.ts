import type { MEditClient } from '../client';
import { fieldOfRecord } from '../drivingLib/fieldMetadata';
import { fieldAt } from '../drivingLib/sourceText';
import { errorMessage } from '../ports/errorMessage';
import type { Reporter } from '../ports/reporter';

interface EnumCompletions {
  start: number;
  end: number;
  items: { label: string; detail: string; insertText: string }[];
}

/** The values of the enum or flags field under the cursor; undefined elsewhere, and where mEdit cannot answer, which the
 *  Output says. */
export async function enumCompletionsAt(
  { client, reporter }: { client: Pick<MEditClient, 'getComparison'>; reporter: Pick<Reporter, 'shownOnSurface'> },
  text: string, offset: number,
): Promise<EnumCompletions | undefined> {
  const found = fieldAt(text, offset);
  if (!found || offset <= found.start) return undefined;
  try {
    const field = await fieldOfRecord(client, found);
    if (field?.type !== 'enum' && field?.type !== 'flags') return undefined;
    return {
      start: found.start + 1, end: found.end - 1,
      items: field.enumMembers.map(({ value, label }) => ({ label: value, detail: label ?? '', insertText: value })),
    };
  } catch (error) {
    reporter.shownOnSurface('error', `Completion cannot list what ${found.recordFormKey} offers here.`, errorMessage(error));
    return undefined;
  }
}

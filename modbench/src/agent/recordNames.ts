import type { MEditClient } from '../client/MEditClient';
import { failureReason, isReadFailed } from '../wire/readFailed';
import { Refusal } from '../drivingLib/refusal';

/** The FormKey each name means, in order; a name that is not a record is refused. */
export async function formKeysNamed(mEdit: Pick<MEditClient, 'resolveNames'>, names: readonly string[]): Promise<string[]> {
  const named = await mEdit.resolveNames(names.map((name) => ({ name })));
  if (isReadFailed(named)) throw new Refusal(failureReason(named));
  const notRecords = names.filter((_, at) => !named[at]?.formKey).map((name) => `"${name}" is not a record.`);
  if (notRecords.length > 0) throw new Refusal(notRecords.join(' '));
  return named.flatMap(({ formKey }) => formKey ?? []);
}

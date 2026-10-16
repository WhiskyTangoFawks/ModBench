import type { MEditClient } from '../client';
import { errorMessage } from '../ports/errorMessage';
import type { Reporter } from '../ports/reporter';
import { answerOf } from '../wire/readFailed';

/** The extensions a created or renamed plugin may take, told as a failure when mEdit cannot say. */
export async function creatablePluginExtensionsOf(
  client: Pick<MEditClient, 'getCreatablePluginExtensions'>, reporter: Reporter,
): Promise<string[] | undefined> {
  try {
    return answerOf(await client.getCreatablePluginExtensions());
  } catch (error) {
    reporter.report('error', 'Could not look up which extensions a plugin may take.', errorMessage(error));
    return undefined;
  }
}

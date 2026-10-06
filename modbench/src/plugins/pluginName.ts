import type { MEditClient } from '../client';
import { errorMessage } from '../ports/errorMessage';
import type { Reporter } from '../ports/reporter';

const listed = new Intl.ListFormat('en-US', { type: 'disjunction' });

/** Why a plugin name is refused whatever place holds it, or undefined (plugins.md, Create plugin,
 *  story 1). `creatableExtensions` are the ones mEdit allows a new plugin in the held game. */
export function pluginNameRefusal(name: string, creatableExtensions: readonly string[]): string | undefined {
  if (!name) return 'Name is required';
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.slice(dot).toLowerCase() : '';
  if (!creatableExtensions.includes(extension)) return `Extension must be ${listed.format(creatableExtensions)}`;
  return undefined;
}

/** What `pluginNameRefusal` needs of the game, told as a failure when mEdit cannot say. */
export async function creatablePluginExtensionsOf(
  client: Pick<MEditClient, 'getCreatablePluginExtensions'>, reporter: Reporter,
): Promise<string[] | undefined> {
  try {
    return await client.getCreatablePluginExtensions();
  } catch (error) {
    reporter.report('error', 'Could not look up which extensions a plugin may take.', errorMessage(error));
    return undefined;
  }
}

import type { MEditClient } from '../client';
import { isPluginFile } from '../instanceAdapter/instanceAdapter';
import { errorMessage } from '../ports/errorMessage';
import type { Reporter } from '../ports/reporter';

/** Why a plugin name is refused whatever place holds it, or undefined (plugins.md, Create plugin,
 *  story 1). */
export function pluginNameRefusal(name: string, lightPluginsSupported: boolean): string | undefined {
  if (!name) return 'Name is required';
  if (!isPluginFile(name)) return 'Extension must be .esp, .esm, or .esl';
  if (!lightPluginsSupported && /\.esl$/i.test(name)) return 'This game has no light plugins';
  return undefined;
}

/** What `pluginNameRefusal` needs of the game, told as a failure when mEdit cannot say. */
export async function lightPluginsSupportedOf(
  client: Pick<MEditClient, 'getLightPluginsSupported'>, reporter: Reporter,
): Promise<boolean | undefined> {
  try {
    return await client.getLightPluginsSupported();
  } catch (error) {
    reporter.report('error', 'Could not look up whether this game has light plugins.', errorMessage(error));
    return undefined;
  }
}

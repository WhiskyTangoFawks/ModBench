// Rename plugin (rename-plugin trace). The client's reach is the plugin source, which only mEdit
// can rename; the file and its lines are the Instance adapter's.

import { OVERWRITE_ORIGIN, type FileOrigin } from '../instanceAdapter/instanceAdapter';
import { isRefused, type MEditClient } from '../client';
import { errorMessage } from '../ports/errorMessage';
import type { PluginAddress } from '../wire/pluginAddress';
import type { PluginsAccess } from './plugins';

export interface PluginRenameAccess extends PluginsAccess {
  readonly client: Pick<MEditClient, 'renameSource'>;
}

/** `sourceRenamed` is true when the files and lines refused after the source had moved. */
export type PluginRenameResult =
  | { applied: true }
  | { applied: false; sourceRenamed: boolean; refusal: string };

const fileOriginOf = (origin: string): FileOrigin =>
  origin === OVERWRITE_ORIGIN ? { kind: 'runtimeOutput' } : { kind: 'mod', name: origin };

export async function renamePlugin(
  access: PluginRenameAccess, plugin: PluginAddress, newName: string, gameRelease: string | undefined,
): Promise<PluginRenameResult> {
  const source = await access.client.renameSource(plugin, newName);
  if (isRefused(source)) return { applied: false, sourceRenamed: false, refusal: source.message };
  try {
    await access.adapter.renamePlugin(fileOriginOf(plugin.origin), plugin.name, newName, gameRelease);
    return { applied: true };
  } catch (err) {
    return { applied: false, sourceRenamed: true, refusal: errorMessage(err) };
  }
}

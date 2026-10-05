// Rename plugin (rename-plugin trace). The client's reach is the plugin source, which only mEdit
// can rename, and the dependants query; the file and its lines are the Instance adapter's.

import { OVERWRITE_ORIGIN, type FileOrigin } from '../instanceAdapter/instanceAdapter';
import { isRefused, type MEditClient } from '../client';
import type { AskQuestion } from '../ports/dialog';
import { errorMessage } from '../ports/errorMessage';
import type { PluginAddress } from '../wire/pluginAddress';
import type { PluginsAccess } from './plugins';

export interface PluginRenameAccess extends PluginsAccess {
  readonly client: Pick<MEditClient, 'renameSource' | 'getPluginDependants'>;
  readonly ask: AskQuestion;
}

/** `sourceRenamed` is true when the files and lines failed after the source had moved. */
export type PluginRenameResult =
  | { applied: true }
  | { applied: false; declined: true }
  | { applied: false; sourceRenamed: boolean; refusal: string };

const CONFIRM = 'Rename';

const fileOriginOf = (origin: string): FileOrigin =>
  origin === OVERWRITE_ORIGIN ? { kind: 'runtimeOutput' } : { kind: 'mod', name: origin };

const named = ({ name, origin }: PluginAddress): string => `${name} (${origin})`;

function listing(heading: string, plugins: readonly PluginAddress[]): string[] {
  return plugins.length === 0 ? [] : [heading, ...plugins.map(named)];
}

const refused = (refusal: string): PluginRenameResult => ({ applied: false, sourceRenamed: false, refusal });

export async function renamePlugin(
  access: PluginRenameAccess, plugin: PluginAddress, newName: string, gameRelease: string | undefined,
): Promise<PluginRenameResult> {
  const origin = fileOriginOf(plugin.origin);
  try {
    await access.adapter.checkPluginRename(origin, plugin.name, newName, gameRelease);
  } catch (err) {
    return refused(errorMessage(err));
  }

  let others;
  try {
    others = await access.client.getPluginDependants(plugin);
  } catch (err) {
    return refused(errorMessage(err));
  }
  if (others.dependants.length + others.unreadable.length > 0) {
    const detail = [
      ...listing('Keep the old name and will show Master issues:', others.dependants),
      ...listing('mEdit could not read their masters, so they may keep the old name:', others.unreadable),
    ].join('\n');
    const answer = await access.ask(`Rename "${plugin.name}" to "${newName}"?`, { modal: true, detail }, CONFIRM);
    if (answer !== CONFIRM) return { applied: false, declined: true };
  }

  const source = await access.client.renameSource(plugin, newName);
  if (isRefused(source)) return refused(source.message);
  try {
    await access.adapter.renamePlugin(origin, plugin.name, newName, gameRelease);
    return { applied: true };
  } catch (err) {
    return { applied: false, sourceRenamed: true, refusal: errorMessage(err) };
  }
}

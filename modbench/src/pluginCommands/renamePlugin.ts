// Rename plugin (rename-plugin trace). The client's reach is the plugin source's changes, which only mEdit
// can answer; the file and its lines are the Instance adapter's.

import type { TailOf } from '../coreLib/boundCommand';
import type { FileOrigin, InstanceAdapter } from '../instanceAdapter/instanceAdapter';
import type { PluginAddress } from '../wire/pluginAddress';
import { isRefused, type MEditClient, type SourceChanges } from '../client';
import { errorMessage } from '../ports/errorMessage';
import { pluginNameRefusal } from './pluginName';
import { answerOf } from '../wire/readFailed';

export type PluginRenameClient = Pick<MEditClient, 'getRenameSourceChanges' | 'moveLastWritten' | 'getCreatablePluginExtensions'>;

interface PluginRenameAccess {
  readonly adapter: InstanceAdapter;
  readonly client: PluginRenameClient;
}

/** `sourceRenamed` is true when the files and lines failed after the source had moved. `reported` is why the source changes could not be applied. */
export type PluginRenameResult =
  | { applied: true }
  | { applied: false; reported: string }
  | { applied: false; sourceRenamed: boolean; refusal: string; detail?: string };

const fileOriginOf = (origin: string): FileOrigin => ({ kind: 'mod', name: origin });

async function renameRefusal(
  access: PluginRenameAccess, plugin: PluginAddress, newName: string, creatableExtensions: readonly string[],
): Promise<string | undefined> {
  const refusal = pluginNameRefusal(newName, creatableExtensions);
  if (refusal !== undefined) return refusal;
  return await access.adapter.originHoldsPlugin(fileOriginOf(plugin.origin), newName) ? `"${plugin.origin}" already holds "${newName}".` : undefined;
}

async function refusalBeforeWrite(access: PluginRenameAccess, plugin: PluginAddress, newName: string): Promise<PluginRenameResult | undefined> {
  let refusal: string | undefined;
  try {
    refusal = await renameRefusal(access, plugin, newName, answerOf(await access.client.getCreatablePluginExtensions()));
  } catch (err) {
    return { applied: false, sourceRenamed: false, refusal: `Could not check "${newName}" for "${plugin.name}" (${plugin.origin}).`, detail: errorMessage(err) };
  }
  return refusal === undefined ? undefined : { applied: false, sourceRenamed: false, refusal };
}

async function renamePlugin(
  access: PluginRenameAccess, source: { apply(changes: SourceChanges): Promise<string | undefined> }, plugin: PluginAddress, newName: string,
): Promise<PluginRenameResult> {
  const refused = await refusalBeforeWrite(access, plugin, newName);
  if (refused !== undefined) return refused;
  const changes = await access.client.getRenameSourceChanges(plugin, newName);
  if (isRefused(changes)) return { applied: false, sourceRenamed: false, refusal: changes.message };
  const unapplied = await source.apply(changes);
  if (unapplied !== undefined) return { applied: false, reported: unapplied };

  const sourceRenamed = changes.moves.length + changes.deletions.length + changes.documents.length > 0;
  const moved = await access.client.moveLastWritten(plugin, changes.treeName, newName);
  if (isRefused(moved)) return { applied: false, sourceRenamed, refusal: moved.message };
  try {
    await access.adapter.renamePlugin(fileOriginOf(plugin.origin), plugin.name, newName);
    return { applied: true };
  } catch (err) {
    return { applied: false, sourceRenamed, refusal: errorMessage(err) };
  }
}

export function pluginRenameCommands(access: PluginRenameAccess) {
  return {
    renameRefusal: (...args: TailOf<typeof renameRefusal>) => renameRefusal(access, ...args),
    renamePlugin: (...args: TailOf<typeof renamePlugin>) => renamePlugin(access, ...args),
  };
}

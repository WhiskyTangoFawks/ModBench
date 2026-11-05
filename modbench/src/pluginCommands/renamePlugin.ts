// Rename plugin (rename-plugin trace): every box whose files name the plugin carries the rename (ADR-0028). The plugin
// source's changes are mEdit's to answer; the file and its lines are the Instance adapter's.

import type { TailOf } from '../coreLib/boundCommand';
import { change, type ChangeResult, type Changing, type SymbolOwners } from '../coreLib/change';
import { fileOriginOfPlugin, type InstanceAdapter } from '../instanceAdapter/instanceAdapter';
import { buildFileReferences, sourceModsOf } from '../manifestAdapter/manifestAdapter';
import type { PluginAddress } from '../wire/pluginAddress';
import { recordIndexReferences, type MEditClient } from '../client';
import { errorMessage } from '../ports/errorMessage';
import { pluginNameRefusal } from './pluginName';
import { answerOf } from '../wire/readFailed';

export type PluginRenameClient = Pick<MEditClient, 'getRenameSourceChanges' | 'moveLastWritten' | 'getCreatablePluginExtensions' | 'getPluginNameReferences'>;

interface PluginRenameAccess {
  readonly adapter: InstanceAdapter;
  readonly client: PluginRenameClient;
}

/** What Text documents gives a rename: the unsaved texts the owners read, and the edit that applies their changes. */
export type RenameEditing = Omit<Changing, 'owners'>;

export type PluginRenameResult = ChangeResult | { readonly applied: false; readonly refusal: string; readonly detail: string };

async function renameRefusal(
  access: PluginRenameAccess, plugin: PluginAddress, newName: string, creatableExtensions: readonly string[],
): Promise<string | undefined> {
  const refusal = pluginNameRefusal(newName, creatableExtensions);
  if (refusal !== undefined) return refusal;
  return await access.adapter.originHoldsPlugin(fileOriginOfPlugin(plugin.origin), newName) ? `"${plugin.origin}" already holds "${newName}".` : undefined;
}

// The Instance adapter defines a plugin; mEdit's plugins and the build files name it.
async function ownersOf({ adapter, client }: PluginRenameAccess): Promise<SymbolOwners> {
  const sourceMods = await sourceModsOf((await adapter.modOrder()).modFolders, await adapter.sourceModFolders(), (name) => adapter.entryKey({ kind: 'mod', name }));
  return { definition: adapter.pluginReferences, references: [recordIndexReferences(client), buildFileReferences(() => sourceMods.folders)] };
}

async function renamePlugin(access: PluginRenameAccess, editing: RenameEditing, plugin: PluginAddress, newName: string): Promise<PluginRenameResult> {
  let owners: SymbolOwners;
  try {
    const refusal = await renameRefusal(access, plugin, newName, answerOf(await access.client.getCreatablePluginExtensions()));
    if (refusal !== undefined) return { applied: false, refusal };
    owners = await ownersOf(access);
  } catch (err) {
    return { applied: false, refusal: `Could not check "${newName}" for "${plugin.name}" (${plugin.origin}).`, detail: errorMessage(err) };
  }
  return change({ owners, ...editing }, plugin, newName);
}

export function pluginRenameCommands(access: PluginRenameAccess) {
  return {
    renameRefusal: (...args: TailOf<typeof renameRefusal>) => renameRefusal(access, ...args),
    renamePlugin: (...args: TailOf<typeof renamePlugin>) => renamePlugin(access, ...args),
  };
}

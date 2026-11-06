// Rename plugin (rename-plugin trace): every box whose files name the plugin carries the rename (ADR-0028). The plugin
// source's changes are mEdit's to answer; the file and its lines are the Instance adapter's.

import type { TailOf } from '../coreLib/boundCommand';
import { change, type ChangeResult, type Changing, type SymbolOwners } from '../coreLib/change';
import { fileOriginOfPlugin, type FileOrigin, type InstanceAdapter } from '../instanceAdapter/instanceAdapter';
import { manifestFileReferences, sourceModsOf } from '../manifestAdapter/manifestAdapter';
import type { ResolvedPlugin } from '../symbolNames/symbolNames';
import { pluginCompanionRule } from '../tables/gamePaths';
import { OVERWRITE_ORIGIN, type PluginAddress } from '../wire/pluginAddress';
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
export type RenameEditing = Omit<Changing, 'owners' | 'plugins'>;

export type PluginRenameResult = ChangeResult | { readonly applied: false; readonly refusal: string; readonly detail: string };

async function renameRefusal(
  access: PluginRenameAccess, plugin: PluginAddress, newName: string, creatableExtensions: readonly string[],
): Promise<string | undefined> {
  const refusal = pluginNameRefusal(newName, creatableExtensions);
  if (refusal !== undefined) return refusal;
  return await access.adapter.originHoldsPlugin(fileOriginOfPlugin(plugin.origin), newName) ? `"${plugin.origin}" already holds "${newName}".` : undefined;
}

// The Instance adapter defines a plugin; mEdit's plugins, the build files and the manifests name it.
async function ownersOf({ adapter, client }: PluginRenameAccess): Promise<SymbolOwners> {
  const sourceMods = await sourceModsOf((await adapter.modOrder()).modFolders, await adapter.sourceModFolders(), (name) => adapter.entryKey({ kind: 'mod', name }));
  const manifestFiles = manifestFileReferences({
    sourceFolders: () => sourceMods.folders,
    modFolderOf: (mod) => adapter.modFolderPath(mod),
    companions: async () => pluginCompanionRule(await adapter.gameRelease()),
  });
  return { definition: adapter.pluginReferences, references: [recordIndexReferences(client, manifestFiles.sourceFilesOf), manifestFiles] };
}

const originName = (origin: FileOrigin): string => (origin.kind === 'mod' ? origin.name : OVERWRITE_ORIGIN);

// The copy mod order resolves the plugin's file name to: Overwrite's, then each enabled mod's, winning first. None of
// them holding it leaves the Data folder's, which no rename names.
async function rowsOf(adapter: InstanceAdapter, { name }: PluginAddress): Promise<ResolvedPlugin[]> {
  const { mods } = await adapter.modOrder();
  const origins: FileOrigin[] = [{ kind: 'runtimeOutput' }, ...mods.flatMap((entry) => (entry.kind === 'mod' && entry.enabled ? [{ kind: 'mod' as const, name: entry.name }] : []))];
  for (const origin of origins) {
    if (await adapter.originHoldsPlugin(origin, name)) return [{ name, origin: originName(origin), winning: true }];
  }
  return [];
}

async function renamePlugin(access: PluginRenameAccess, editing: RenameEditing, plugin: PluginAddress, newName: string): Promise<PluginRenameResult> {
  let owners: SymbolOwners;
  let plugins: ResolvedPlugin[];
  try {
    const refusal = await renameRefusal(access, plugin, newName, answerOf(await access.client.getCreatablePluginExtensions()));
    if (refusal !== undefined) return { applied: false, refusal };
    [owners, plugins] = await Promise.all([ownersOf(access), rowsOf(access.adapter, plugin)]);
  } catch (err) {
    return { applied: false, refusal: `Could not check "${newName}" for "${plugin.name}" (${plugin.origin}).`, detail: errorMessage(err) };
  }
  return change({ owners, plugins, ...editing }, plugin, newName);
}

export function pluginRenameCommands(access: PluginRenameAccess) {
  return {
    renameRefusal: (...args: TailOf<typeof renameRefusal>) => renameRefusal(access, ...args),
    renamePlugin: (...args: TailOf<typeof renamePlugin>) => renamePlugin(access, ...args),
  };
}

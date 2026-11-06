// Rename plugin (rename-plugin trace): every box whose files name the plugin carries the rename (ADR-0028). The plugin
// source's changes are mEdit's to answer; the file and its lines are the Instance adapter's.

import type { TailOf } from '../coreLib/boundCommand';
import { change, type RenameEditing, type SymbolOwners } from '../coreLib/change';
import type { ChangeResult } from '../ports/changeResult';
import { fileOriginOfPlugin, type InstanceAdapter } from '../instanceAdapter/instanceAdapter';
import { manifestFileReferences, sourceModsOf } from '../manifestAdapter/manifestAdapter';
import { originsWinningFirst, type RankedOrigin, type ResolvedPlugin, type SymbolOwner } from '../symbolNames/symbolNames';
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

export type PluginRenameResult = ChangeResult | { readonly applied: false; readonly refusal: string; readonly detail: string };

async function renameRefusal(
  access: PluginRenameAccess, plugin: PluginAddress, newName: string, creatableExtensions: readonly string[],
): Promise<string | undefined> {
  const refusal = pluginNameRefusal(newName, creatableExtensions);
  if (refusal !== undefined) return refusal;
  return await access.adapter.originHoldsPlugin(fileOriginOfPlugin(plugin.origin), newName) ? `"${plugin.origin}" already holds "${newName}".` : undefined;
}

// The Instance adapter defines a plugin; mEdit's plugins, the build files and the manifests name it.
async function ownersOf({ adapter, client }: PluginRenameAccess): Promise<SymbolOwners<SymbolOwner>> {
  const sourceMods = await sourceModsOf((await adapter.modOrder()).modFolders, await adapter.sourceModFolders(), (name) => adapter.entryKey({ kind: 'mod', name }));
  const manifestFiles = manifestFileReferences({
    sourceFolders: () => sourceMods.folders,
    modFolderOf: (mod) => adapter.modFolderPath(mod),
    companions: async () => pluginCompanionRule(await adapter.gameRelease()),
  });
  return { definition: adapter.pluginReferences, references: [recordIndexReferences(client, manifestFiles.sourceFilesOf), manifestFiles] };
}

const originName = (origin: RankedOrigin): string => (origin.kind === 'mod' ? origin.name : OVERWRITE_ORIGIN);

// The copy mod order resolves the plugin's file name to; the Data folder's, which no rename names, when no origin holds it.
async function rowsOf(adapter: InstanceAdapter, { name }: PluginAddress): Promise<ResolvedPlugin[]> {
  for (const origin of originsWinningFirst((await adapter.modOrder()).mods)) {
    if (await adapter.originHoldsPlugin(origin, name)) return [{ name, origin: originName(origin), winning: true }];
  }
  return [];
}

async function renamePlugin(access: PluginRenameAccess, { held, apply }: RenameEditing, plugin: PluginAddress, newName: string): Promise<PluginRenameResult> {
  let owners: SymbolOwners<SymbolOwner>;
  let plugins: ResolvedPlugin[];
  try {
    const refusal = await renameRefusal(access, plugin, newName, answerOf(await access.client.getCreatablePluginExtensions()));
    if (refusal !== undefined) return { applied: false, refusal };
    [owners, plugins] = await Promise.all([ownersOf(access), rowsOf(access.adapter, plugin)]);
  } catch (err) {
    return { applied: false, refusal: `Could not check "${newName}" for "${plugin.name}" (${plugin.origin}).`, detail: errorMessage(err) };
  }
  return change(owners, (owner) => owner.plan(plugin, newName, held, plugins), apply);
}

export function pluginRenameCommands(access: PluginRenameAccess) {
  return {
    renameRefusal: (...args: TailOf<typeof renameRefusal>) => renameRefusal(access, ...args),
    renamePlugin: (...args: TailOf<typeof renamePlugin>) => renamePlugin(access, ...args),
  };
}

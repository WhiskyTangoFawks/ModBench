// Decompile and repair (plugin-source.md, Decompile and repair): mEdit writes the two commits of each plugin. A mod with
// no repository is handed the one init source mod would make.

import { isRefused, type MEditClient, type NewRepository, type PluginAddress, type PluginToRepair } from '../client';
import type { InstanceAdapter } from '../instanceAdapter/instanceAdapter';
import { sourceModsOf } from '../manifestAdapter/manifestAdapter';
import type { SelectionResult } from '../coreLib/commandResult';
import type { ItemRefusal } from '../ports/selectionOutcome';

export type DecompileAndRepairClient = Pick<MEditClient, 'decompileAndRepair'>;

interface MadeRepository {
  readonly modFolder: string;
  readonly repository: NewRepository;
}

/** The repository init source mod makes for a mod, and each committed mod's folder linked to the one made for it:
 *  why not, by the mod. */
export interface NewRepositories {
  readonly of: (mod: string) => Promise<MadeRepository | { readonly refusal: string }>;
  readonly notLinked: (made: ReadonlyMap<string, MadeRepository>, committed: readonly string[]) => Promise<ReadonlyMap<string, string>>;
}

interface DecompileAndRepairAccess {
  readonly adapter: Pick<InstanceAdapter, 'modOrder' | 'sourceRepositories' | 'entryKey'>;
  readonly client: DecompileAndRepairClient;
  readonly newRepositories: NewRepositories;
}

// plugin-source.md, Decompile and repair, story 4: a mod with no repository gets one, as init source mod makes it.
async function toRepair(
  { adapter, newRepositories }: Omit<DecompileAndRepairAccess, 'client'>, plugins: readonly PluginAddress[],
): Promise<{ readonly plugins: PluginToRepair[]; readonly refused: ItemRefusal<PluginAddress>[]; readonly made: ReadonlyMap<string, MadeRepository> }> {
  const sourceMods = await sourceModsOf((await adapter.modOrder()).modFolders, await adapter.sourceRepositories(), (name) => adapter.entryKey({ kind: 'mod', name }));
  const made = new Map<string, MadeRepository | { readonly refusal: string }>();
  const toSend: PluginToRepair[] = [];
  const refused: ItemRefusal<PluginAddress>[] = [];
  for (const plugin of plugins) {
    if (sourceMods.folderOf(plugin.origin) !== undefined) {
      toSend.push({ plugin });
      continue;
    }
    const repository = made.get(plugin.origin) ?? await newRepositories.of(plugin.origin);
    made.set(plugin.origin, repository);
    if ('refusal' in repository) refused.push({ item: plugin, reason: `${plugin.origin} has no repository, and one cannot be made: ${repository.refusal}` });
    else toSend.push({ plugin, newRepository: repository.repository });
  }
  return { plugins: toSend, refused, made: new Map([...made].flatMap(([mod, repository]) => ('refusal' in repository ? [] : [[mod, repository] as const]))) };
}

// plugin-source.md, Decompile and repair, story 4: the mod is a source mod once its folder's manifest names its repository.
async function foldersLinked(
  newRepositories: NewRepositories, made: ReadonlyMap<string, MadeRepository>, landed: readonly PluginAddress[],
): Promise<ItemRefusal<PluginAddress>[]> {
  const notLinked = await newRepositories.notLinked(made, [...new Set(landed.map(({ origin }) => origin))]);
  return [...notLinked].flatMap(([mod, why]) => {
    const item = landed.find(({ origin }) => origin === mod);
    return item === undefined ? [] : [{ item, reason: `was repaired, but ${why}.` }];
  });
}

export async function decompileAndRepair(
  access: DecompileAndRepairAccess, plugins: readonly PluginAddress[], force: boolean,
): Promise<SelectionResult<PluginAddress>> {
  const sent = await toRepair(access, plugins);
  if (sent.plugins.length === 0) return { applied: true, outcome: { landed: [], refused: sent.refused } };
  const repaired = await access.client.decompileAndRepair(sent.plugins, force);
  if (isRefused(repaired)) return { applied: false, refusal: repaired.message };
  const notLinked = await foldersLinked(access.newRepositories, sent.made, repaired.landed);
  return { applied: true, outcome: { landed: repaired.landed, refused: [...sent.refused, ...repaired.refused, ...notLinked] } };
}

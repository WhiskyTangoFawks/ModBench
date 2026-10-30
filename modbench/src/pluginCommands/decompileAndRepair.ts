// Decompile and repair (plugin-source.md, Decompile and repair): mEdit writes the two commits of each plugin. A mod with
// no repository is handed the one decompile and commit would make.

import { isRefused, type MEditClient, type NewRepository, type PluginAddress, type PluginToRepair } from '../client';
import type { InstanceAdapter } from '../instanceAdapter/instanceAdapter';
import type { SelectionResult } from '../coreLib/commandResult';
import type { ItemRefusal } from '../ports/selectionOutcome';

export type DecompileAndRepairClient = Pick<MEditClient, 'decompileAndRepair'>;

interface MadeRepository {
  readonly repository: NewRepository;
  readonly folder: string;
}

/** The repository decompile and commit makes for a mod, and why its folder's manifest stayed once it was made. */
export interface NewRepositories {
  readonly of: (mod: string) => Promise<MadeRepository | { readonly refusal: string }>;
  readonly folderManifestRemovedOrWhy: (made: MadeRepository) => Promise<string | undefined>;
}

interface DecompileAndRepairAccess {
  readonly adapter: Pick<InstanceAdapter, 'sourceMods'>;
  readonly client: DecompileAndRepairClient;
  readonly newRepositories: NewRepositories;
}

// plugin-source.md, Decompile and repair, story 4: a mod with no repository gets one, as decompile and commit makes it.
async function toRepair(
  { adapter, newRepositories }: DecompileAndRepairAccess, plugins: readonly PluginAddress[],
): Promise<{ readonly plugins: PluginToRepair[]; readonly refused: ItemRefusal<PluginAddress>[]; readonly made: ReadonlyMap<string, MadeRepository> }> {
  const sourceMods = await adapter.sourceMods();
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

export async function decompileAndRepair(
  access: DecompileAndRepairAccess, plugins: readonly PluginAddress[], force: boolean,
): Promise<SelectionResult<PluginAddress>> {
  const { client, newRepositories } = access;
  const sent = await toRepair(access, plugins);
  if (sent.plugins.length === 0) return { applied: true, outcome: { landed: [], refused: sent.refused } };
  const repaired = await client.decompileAndRepair(sent.plugins, force);
  if (isRefused(repaired)) return { applied: false, refusal: repaired.message };
  const notRemoved = await folderManifestsRemoved(newRepositories, sent.made, repaired.landed);
  return { applied: true, outcome: { landed: repaired.landed, refused: [...sent.refused, ...repaired.refused, ...notRemoved] } };
}

// ADR-0022: a mod's manifest is in its repository once one is made.
async function folderManifestsRemoved(
  newRepositories: NewRepositories, made: ReadonlyMap<string, MadeRepository>, landed: readonly PluginAddress[],
): Promise<ItemRefusal<PluginAddress>[]> {
  const notRemoved: ItemRefusal<PluginAddress>[] = [];
  for (const [mod, repository] of made) {
    const repaired = landed.find(({ origin }) => origin === mod);
    const why = repaired === undefined ? undefined : await newRepositories.folderManifestRemovedOrWhy(repository);
    if (repaired !== undefined && why !== undefined) notRemoved.push({ item: repaired, reason: `was repaired, but ${why}` });
  }
  return notRemoved;
}

// Decompile and repair (plugin-source.md, Decompile and repair): mEdit previews each change, then writes the two
// commits of each plugin it previewed. A mod with no repository is handed the one decompile and commit would make.

import { isRefused, type MEditClient, type NewRepository, type PluginAddress, type PluginRepairPreview, type PluginToRepair } from '../client';
import type { InstanceAdapter } from '../instanceAdapter/instanceAdapter';
import type { SelectionResult } from '../coreLib/commandResult';
import type { ItemRefusal } from '../ports/selectionOutcome';
import { pluginRowName } from '../wire/pluginAddress';

export type DecompileAndRepairClient = Pick<MEditClient, 'repairPreviews' | 'decompileAndRepair'>;

/** The repository made for a mod with none, and its folder. */
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

/** Each change a plugin's preview names, with its record, or the diagnosis no change answers. */
export function previewLines({ plugin, diagnoses }: PluginRepairPreview): string[] {
  return diagnoses.map(({ diagnosis, change }) => `${pluginRowName(plugin)}: ${diagnosis.anchor ?? 'the plugin'}: `
    + (change == null ? `no repair answers ${diagnosis.message}` : change.description));
}

const droppingData = (previews: readonly PluginRepairPreview[]): PluginRepairPreview[] =>
  previews.map((preview) => ({ ...preview, diagnoses: preview.diagnoses.filter(({ change }) => change?.dropsData === true) }))
    .filter(({ diagnoses }) => diagnoses.length > 0);

// plugin-source.md, Decompile and repair, story 7: a mod with no repository gets one, as decompile and commit makes it.
async function toRepair(
  { adapter, newRepositories }: DecompileAndRepairAccess, previews: readonly PluginRepairPreview[],
): Promise<{ readonly plugins: PluginToRepair[]; readonly refused: ItemRefusal<PluginAddress>[]; readonly made: ReadonlyMap<string, MadeRepository> }> {
  const sourceMods = await adapter.sourceMods();
  const made = new Map<string, MadeRepository | { readonly refusal: string }>();
  const plugins: PluginToRepair[] = [];
  const refused: ItemRefusal<PluginAddress>[] = [];
  for (const { plugin, hash } of previews) {
    if (sourceMods.folderOf(plugin.origin) !== undefined) {
      plugins.push({ plugin, hash });
      continue;
    }
    const repository = made.get(plugin.origin) ?? await newRepositories.of(plugin.origin);
    made.set(plugin.origin, repository);
    if ('refusal' in repository) refused.push({ item: plugin, reason: `${plugin.origin} has no repository, and one cannot be made: ${repository.refusal}` });
    else plugins.push({ plugin, hash, newRepository: repository.repository });
  }
  return { plugins, refused, made: new Map([...made].flatMap(([mod, repository]) => ('refusal' in repository ? [] : [[mod, repository] as const]))) };
}

/** `previewed` hears each plugin's preview before anything is written. `agrees`, when given and not forced, hears the
 *  changes that drop data, and a no writes nothing. Without it, mEdit refuses such a repair, naming force. */
export async function decompileAndRepair(
  access: DecompileAndRepairAccess, plugins: readonly PluginAddress[], force: boolean,
  previewed: (preview: PluginRepairPreview) => void,
  agrees?: (dropping: readonly PluginRepairPreview[]) => Promise<boolean>,
): Promise<SelectionResult<PluginAddress>> {
  const { client, newRepositories } = access;
  const previews = await client.repairPreviews(plugins);
  if (isRefused(previews)) return { applied: false, refusal: previews.message };
  previews.landed.forEach(previewed);
  if (previews.landed.length === 0) return { applied: true, outcome: { landed: [], refused: previews.refused } };

  const dropping = droppingData(previews.landed);
  const agreedDrops = !force && agrees !== undefined && dropping.length > 0;
  if (agreedDrops && !await agrees(dropping)) return { applied: true, outcome: { landed: [], refused: previews.refused } };

  const sent = await toRepair(access, previews.landed);
  if (sent.plugins.length === 0) return { applied: true, outcome: { landed: [], refused: [...previews.refused, ...sent.refused] } };
  const repaired = await client.decompileAndRepair(sent.plugins, force, agreedDrops);
  if (isRefused(repaired)) return { applied: false, refusal: repaired.message };
  const notRemoved = await folderManifestsRemoved(newRepositories, sent.made, repaired.landed);
  return { applied: true, outcome: { landed: repaired.landed, refused: [...previews.refused, ...sent.refused, ...repaired.refused, ...notRemoved] } };
}

// modlist-repository.md, The manifest, story 1: a mod's manifest is in its repository once one is made.
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

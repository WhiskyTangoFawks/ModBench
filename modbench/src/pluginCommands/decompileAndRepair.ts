// Decompile and repair (source.md, Decompile and repair): mEdit writes the two commits of each plugin. A mod with
// no repository is handed the one version in git would make.

import { isRefused, type MEditClient, type PluginAddress, type PluginToRepair, type SourceFolderRequest, type SourceModIn } from '../client';
import type { InstanceAdapter } from '../instanceAdapter/instanceAdapter';
import { sourceModsOf } from '../manifestAdapter/manifestAdapter';
import type { SelectionResult } from '../coreLib/commandResult';
import type { ItemRefusal } from '../ports/selectionOutcome';

export type DecompileAndRepairClient = Pick<MEditClient, 'decompileAndRepair'>;

interface MadeRepository {
  readonly modFolder: string;
  readonly repository: SourceFolderRequest;
}

/** The repository version in git makes for a mod, each committed mod linked to it, and the modlist repository's ignore-list
 *  lines for source folders: let in (why not) and taken back (what stays). */
export interface NewRepositories {
  readonly of: (mod: string) => Promise<MadeRepository | { readonly refusal: string }>;
  readonly notLinked: (made: ReadonlyMap<string, MadeRepository>, committed: readonly string[]) => Promise<ReadonlyMap<string, string>>;
  readonly letIn: (sourceFolders: readonly string[]) => Promise<string | undefined>;
  readonly takeBack: (sourceFolders: readonly string[]) => Promise<string[]>;
}

/** Where git holds a mod that is not a source mod: asked only when a plugin needs it; undefined when the user dismissed the pick. */
export type WhereGitHolds = () => Promise<SourceModIn | undefined>;

interface DecompileAndRepairAccess {
  readonly adapter: Pick<InstanceAdapter, 'modOrder' | 'sourceRepositories' | 'entryKey'>;
  readonly client: DecompileAndRepairClient;
  readonly newRepositories: NewRepositories;
}

// source.md, Decompile and repair, story 4: a mod that is not a source mod gets a source folder, in the repository the user picks.
async function toRepair(
  { adapter, newRepositories }: Omit<DecompileAndRepairAccess, 'client'>, plugins: readonly PluginAddress[], where: WhereGitHolds,
): Promise<{ readonly plugins: PluginToRepair[]; readonly refused: ItemRefusal<PluginAddress>[]; readonly made: ReadonlyMap<string, MadeRepository> } | undefined> {
  const sourceMods = await sourceModsOf((await adapter.modOrder()).modFolders, await adapter.sourceRepositories(), (name) => adapter.entryKey({ kind: 'mod', name }));
  const needsOne = plugins.some(({ origin }) => sourceMods.folderOf(origin) === undefined);
  const heldIn = needsOne ? await where() : 'NewRepository';
  if (heldIn === undefined) return undefined;
  const made = new Map<string, MadeRepository | { readonly refusal: string }>();
  for (const mod of new Set(plugins.map(({ origin }) => origin))) {
    if (sourceMods.folderOf(mod) === undefined) made.set(mod, await newRepositories.of(mod));
  }
  const notLetIn = heldIn === 'ModlistRepository'
    ? await newRepositories.letIn([...made.values()].flatMap((repository) => ('refusal' in repository ? [] : [repository.repository.sourceFolder])))
    : undefined;
  const toSend: PluginToRepair[] = [];
  const refused: ItemRefusal<PluginAddress>[] = [];
  for (const plugin of plugins) {
    const repository = made.get(plugin.origin);
    if (repository === undefined) toSend.push({ plugin });
    else if ('refusal' in repository) refused.push({ item: plugin, reason: `${plugin.origin} has no repository, and one cannot be made: ${repository.refusal}` });
    else if (notLetIn !== undefined) refused.push({ item: plugin, reason: `${plugin.origin} has no repository, and one cannot be made: ${notLetIn}` });
    else toSend.push({ plugin, sourceFolder: repository.repository, in: heldIn });
  }
  const sent = new Set(toSend.map(({ plugin }) => plugin.origin));
  return { plugins: toSend, refused, made: new Map([...made].flatMap(([mod, repository]) => (!('refusal' in repository) && sent.has(mod) ? [[mod, repository] as const] : []))) };
}

// source.md, Decompile and repair, story 4: the mod is a source mod once its folder's manifest names its repository.
async function foldersLinked(
  newRepositories: NewRepositories, made: ReadonlyMap<string, MadeRepository>, landed: readonly PluginAddress[],
): Promise<ItemRefusal<PluginAddress>[]> {
  const notLinked = await newRepositories.notLinked(made, [...new Set(landed.map(({ origin }) => origin))]);
  return [...notLinked].flatMap(([mod, why]) => {
    const item = landed.find(({ origin }) => origin === mod);
    return item === undefined ? [] : [{ item, reason: `was repaired, but ${why}.` }];
  });
}

// The ignore list lets in only the folders of mods that became source mods in the modlist repository.
async function linesTakenBack(
  newRepositories: NewRepositories, made: ReadonlyMap<string, MadeRepository>, landed: readonly PluginAddress[],
): Promise<string[]> {
  const landedMods = new Set(landed.map(({ origin }) => origin));
  const sourceFolders = [...made].filter(([mod]) => !landedMods.has(mod)).map(([, { repository }]) => repository.sourceFolder);
  return sourceFolders.length === 0 ? [] : newRepositories.takeBack(sourceFolders);
}

export async function decompileAndRepair(
  access: DecompileAndRepairAccess, plugins: readonly PluginAddress[], force: boolean,
  where: WhereGitHolds = () => Promise.resolve('NewRepository'),
): Promise<SelectionResult<PluginAddress>> {
  const sent = await toRepair(access, plugins, where);
  if (sent === undefined) return { applied: true, outcome: { landed: [], refused: [] } };
  if (sent.plugins.length === 0) return { applied: true, outcome: { landed: [], refused: sent.refused } };
  const holdsLines = sent.plugins.some(({ in: heldIn }) => heldIn === 'ModlistRepository');
  const repaired = await access.client.decompileAndRepair(sent.plugins, force);
  const notTakenBack = holdsLines ? await linesTakenBack(access.newRepositories, sent.made, isRefused(repaired) ? [] : repaired.landed) : [];
  if (isRefused(repaired)) return { applied: false, refusal: [repaired.message, ...notTakenBack].join(' ') };
  const notLinked = await foldersLinked(access.newRepositories, sent.made, repaired.landed);
  const refused = [...sent.refused, ...repaired.refused, ...notLinked];
  const remaining = notTakenBack.length === 0 ? refused : refused.map((item, at) => (at === 0 ? { ...item, reason: `${item.reason} ${notTakenBack.join(' ')}` } : item));
  return { applied: true, outcome: { landed: repaired.landed, refused: remaining } };
}

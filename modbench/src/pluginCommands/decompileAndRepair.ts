// Decompile and repair (source.md, Decompile and repair): mEdit writes the two commits of each plugin. A mod that is
// not a source mod is made one, as version in git makes it.

import { isRefused, type MEditClient, type PluginAddress, type PluginToRepair, type SourceFolderRequest, type SourceModIn, type WriteRefused } from '../client';
import type { InstanceAdapter } from '../instanceAdapter/instanceAdapter';
import { sourceModsOf } from '../manifestAdapter/manifestAdapter';
import type { SelectionResult } from '../coreLib/commandResult';
import type { ItemRefusal, SelectionOutcome } from '../ports/selectionOutcome';

export type DecompileAndRepairClient = Pick<MEditClient, 'decompileAndRepair'>;

interface MadeSourceFolder {
  readonly modFolder: string;
  readonly sourceFolder: SourceFolderRequest;
}

interface PlacedMods<R> {
  readonly outcome: R | WriteRefused;
  readonly notMade: ReadonlyMap<string, string>;
  readonly notLinked: ReadonlyMap<string, string>;
  readonly notTakenBack: ReadonlyMap<string, string>;
  readonly withLinesLeft: <T>(refused: readonly ItemRefusal<T>[], modOf: (item: T) => string) => ItemRefusal<T>[];
}

/** The flow version in git shares (sourceCommands/newRepository.ts, `modsPlaced`), handed in by the composition root. */
export type PlaceMods = <R>(
  request: { readonly mods: readonly string[]; readonly where: SourceModIn },
  run: (made: ReadonlyMap<string, MadeSourceFolder>) => Promise<R | WriteRefused>,
  landedBy: (outcome: R) => Iterable<string>,
) => Promise<PlacedMods<R> | WriteRefused>;

/** Where git holds a mod that is not a source mod: asked only when a plugin needs it; undefined when the pick is dismissed. */
export type WhereGitHolds = () => Promise<SourceModIn | undefined>;

interface DecompileAndRepairAccess {
  readonly adapter: Pick<InstanceAdapter, 'modOrder' | 'sourceRepositories' | 'entryKey'>;
  readonly client: DecompileAndRepairClient;
  readonly newRepositories: PlaceMods;
}

// source.md, Decompile and repair, story 4: one item for a mod, the first plugin of it that landed.
function firstLandedOf(landed: readonly PluginAddress[], notLinked: ReadonlyMap<string, string>): ItemRefusal<PluginAddress>[] {
  return [...notLinked].flatMap(([mod, why]) => {
    const item = landed.find(({ origin }) => origin === mod);
    return item === undefined ? [] : [{ item, reason: `was repaired, but ${why}.` }];
  });
}

export async function decompileAndRepair(
  { adapter, client, newRepositories }: DecompileAndRepairAccess, plugins: readonly PluginAddress[], force: boolean,
  where: WhereGitHolds = () => Promise.resolve('NewRepository'),
): Promise<SelectionResult<PluginAddress>> {
  const sourceMods = await sourceModsOf((await adapter.modOrder()).modFolders, await adapter.sourceRepositories(), (name) => adapter.entryKey({ kind: 'mod', name }));
  const notSourceMods = [...new Set(plugins.map(({ origin }) => origin).filter((mod) => sourceMods.folderOf(mod) === undefined))];
  const heldIn = notSourceMods.length > 0 ? await where() : 'NewRepository';
  if (heldIn === undefined) return { applied: true, outcome: { landed: [], refused: [] } };
  const repaired = (made: ReadonlyMap<string, MadeSourceFolder>): Promise<SelectionOutcome<PluginAddress> | WriteRefused> => {
    const toSend = plugins.flatMap((plugin): PluginToRepair[] => {
      if (sourceMods.folderOf(plugin.origin) !== undefined) return [{ plugin }];
      const folder = made.get(plugin.origin);
      return folder === undefined ? [] : [{ plugin, sourceFolder: folder.sourceFolder }];
    });
    return toSend.length === 0 ? Promise.resolve({ landed: [], refused: [] }) : client.decompileAndRepair(toSend, force);
  };
  const placed = await newRepositories({ mods: notSourceMods, where: heldIn }, repaired, (outcome) => outcome.landed.map(({ origin }) => origin));
  if (isRefused(placed)) return { applied: false, refusal: placed.message };
  const { outcome, notMade, notLinked, notTakenBack } = placed;
  if (isRefused(outcome)) return { applied: false, refusal: [outcome.message, ...notTakenBack.values()].join(' ') };
  const notMadePlugins = plugins.filter(({ origin }) => notMade.has(origin)).map((item) => ({
    item, reason: `${item.origin} has no repository, and one cannot be made: ${notMade.get(item.origin) ?? ''}`,
  }));
  const refused = placed.withLinesLeft([...notMadePlugins, ...outcome.refused, ...firstLandedOf(outcome.landed, notLinked)], ({ origin }) => origin);
  return { applied: true, outcome: { landed: outcome.landed, refused } };
}

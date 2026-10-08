// Every change to a profile's plugin order (ADR-0014; ADR-0015).

import { pluginKey } from '../loadOrderFileCodec/pluginsText';
import { dropIndexIn, type Drop } from './dropIndex';
import type { CommandResult, SelectionResult } from '../coreLib/commandResult';
import { refuse } from '../ports/refuse';
import type { MEditClient, PluginAddress, PluginMetadata } from '../client';
import { moveOrderRefusal, type PluginOrderFactsOf } from './pluginOrder';
import type { ItemRefusal } from '../ports/selectionOutcome';
import type {
  DataFolderPlugins, DecidePluginOrder, InstanceAdapter, PluginEntry, PluginOrderChange,
} from '../instanceAdapter/instanceAdapter';

async function changePluginOrder(
  adapter: InstanceAdapter, profile: string, decide: DecidePluginOrder,
): Promise<CommandResult> {
  try {
    // A change already true of the order is not written: for `syncPlugins` that is the
    // difference between a loop that settles and one that does not.
    const { wrote } = await adapter.changePluginOrder(profile, decide);
    return { applied: true, wrote };
  } catch (err) {
    return refuse(err);
  }
}

/** One plugin's target state — the check box's own shape, where several rows toggled at once can
 *  each ask for a different state. */
export interface PluginParticipation {
  name: string;
  enabled: boolean;
}

/** `modbench.plugin.enable` / `modbench.plugin.disable` and the check box, over the whole
 *  selection in one write (commands.md, "A selection is one gesture") — every entry lands or is
 *  refused by name, whatever state each one asks for. */
export async function setPluginsParticipation(
  adapter: InstanceAdapter, profile: string, entries: readonly PluginParticipation[],
): Promise<SelectionResult<string>> {
  let landed: string[] = [];
  let refused: ItemRefusal<string>[] = [];
  const outcome = await changePluginOrder(adapter, profile, (order) => {
    const known = new Set(order.map((entry) => entry.name));
    const found = entries.filter((entry) => known.has(entry.name));
    landed = found.map((entry) => entry.name);
    refused = entries.filter((entry) => !known.has(entry.name))
      .map((entry) => ({ item: entry.name, reason: `Plugin not found in plugins.txt: ${entry.name}` }));
    return found.map(({ name, enabled }) => ({ kind: 'enable', plugin: name, enabled }));
  });
  return outcome.applied ? { applied: true, outcome: { landed, refused } } : outcome;
}

/** `setPluginsParticipation`, one state for the whole selection — the menu and the key's own
 *  shape, which never mixes directions in one gesture. */
export function setPluginsEnabled(
  adapter: InstanceAdapter, profile: string, pluginNames: readonly string[], enabled: boolean,
): Promise<SelectionResult<string>> {
  return setPluginsParticipation(adapter, profile, pluginNames.map((name) => ({ name, enabled })));
}

/** Where a drag landed in the Plugins tree. */
export type { Drop as PluginsDrop } from './dropIndex';

export type PluginMasters = Pick<MEditClient, 'getPlugins'>;

// The game loads one copy of a name: the one in the load order (ADR-0012). Several copies with
// none in it name no one copy, so none is judged; nor is anything while mEdit cannot answer.
async function orderFactsFrom(masters: PluginMasters): Promise<PluginOrderFactsOf> {
  const held = await masters.getPlugins().catch(() => [] as PluginMetadata[]);
  return (name) => {
    const copies = held.filter((plugin) => pluginKey(plugin.name) === pluginKey(name));
    const loaded = copies.length === 1 ? copies : copies.filter((copy) => copy.inLoadOrder);
    const [copy] = loaded;
    return loaded.length === 1 && copy !== undefined ? { masters: copy.masters, blueprint: copy.isBlueprint } : undefined;
  };
}

export async function reorderPlugins(
  adapter: InstanceAdapter, masters: PluginMasters, profile: string, plugins: readonly PluginAddress[], drop: Drop,
  loadedWithNoLine: readonly string[],
): Promise<CommandResult> {
  const pluginNames = plugins.map((plugin) => plugin.name);
  const noLine = new Set(loadedWithNoLine.map(pluginKey));
  const factsOf = await orderFactsFrom(masters);
  // Settled against the order the change lands on, so a tree a generation behind plugins.txt
  // cannot land the block at a stale index.
  return changePluginOrder(adapter, profile, (order) => {
    const names = order.map((p) => p.name);
    // A line for a plugin the game loads with no line does not place it.
    const refusal = moveOrderRefusal(names.filter((name) => !noLine.has(pluginKey(name))), pluginNames, drop, factsOf);
    if (refusal !== undefined) throw new Error(refusal);
    return [{ kind: 'move', plugins: pluginNames, toIndex: dropIndexIn(names, pluginNames, drop) }];
  });
}

interface PluginLinesDelta {
  // Real on-disk names whose line is added, disabled, ascending case-folded.
  added: string[];
  // plugins.txt names (as written) whose line is dropped.
  dropped: string[];
}

export type PluginSyncResult =
  | { applied: true; wrote: boolean; added: string[]; dropped: string[] }
  | { applied: false; refusal: string }
  | { applied: false; toldAsInstanceState: true };

// `inData` is presence only, never a source of added lines.
function pluginLinesDelta(
  listed: readonly string[],
  provided: ReadonlyMap<string, string>,
  inData: ReadonlySet<string>,
): PluginLinesDelta {
  const listedKeys = new Set(listed.map(pluginKey));
  const added = [...provided]
    .filter(([key]) => !listedKeys.has(key))
    .map(([, real]) => real)
    .sort((a, b) => pluginKey(a).localeCompare(pluginKey(b)));
  const dropped = listed.filter((name) => !provided.has(pluginKey(name)) && !inData.has(pluginKey(name)));
  return { added, dropped };
}

const changedSinceRead = (order: readonly PluginEntry[], read: readonly PluginEntry[]): boolean =>
  order.length !== read.length || order.some((line, i) => line.name !== read[i]?.name);

async function syncPlugins(
  adapter: InstanceAdapter, { profile, pluginOrder, provided, inData, loadedWithNoLine }: PluginSyncInputs,
): Promise<PluginSyncResult> {
  // Without the Data folder's listing, a line for a Data plugin would be dropped. A game folder
  // not found is told once, as the instance's state (common.md, States, story 5).
  if (inData.kind === 'unresolved') return { applied: false, toldAsInstanceState: true };
  if (inData.kind === 'unreadable') {
    return { applied: false, refusal: `the game's Data folder cannot be listed: ${inData.reason}` };
  }
  // The tree gives a plugin the game loads with no line a row of its own (plugins.md, The tree,
  // story 2), so a mod's plugin of that name earns no line.
  const noLine = new Set((loadedWithNoLine ?? []).map(pluginKey));
  const addable = new Map([...provided].filter(([key]) => !noLine.has(key)));
  const inDataNames = inData.names;

  let delta: PluginLinesDelta = { added: [], dropped: [] };
  const result = await changePluginOrder(adapter, profile, (order) => {
    if (changedSinceRead(order, pluginOrder)) return [];
    delta = pluginLinesDelta(order.map((e) => e.name), addable, inDataNames);
    return [
      ...delta.dropped.map((plugin): PluginOrderChange => ({ kind: 'drop', plugin })),
      ...delta.added.map((plugin): PluginOrderChange => ({ kind: 'add', plugin })),
    ];
  });
  return result.applied ? { ...result, ...delta } : result;
}

interface PluginSyncInputs {
  readonly profile: string;
  readonly pluginOrder: readonly PluginEntry[];
  readonly provided: ReadonlyMap<string, string>;
  readonly inData: DataFolderPlugins;
  readonly loadedWithNoLine: readonly string[] | undefined;
}

/** Plugin sync on one run's inputs. */
export type PluginSyncRun = (inputs: PluginSyncInputs) => Promise<PluginSyncResult>;

/** `syncPlugins` bound to one instance. */
export function pluginSyncOver(adapter: InstanceAdapter): PluginSyncRun {
  return (inputs) => syncPlugins(adapter, inputs);
}

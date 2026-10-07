// Every change to a profile's plugin order (ADR-0014; ADR-0015).

import { pluginKey } from '../loadOrderFileCodec/pluginsText';
import { dropIndexIn, type Drop } from './dropIndex';
import { refuse } from '../ports/refuse';
import type { MEditClient, PluginMetadata } from '../client';
import { moveOrderRefusal, type PluginOrderFacts, type PluginOrderFactsOf } from './pluginOrder';
import type { ItemRefusal, SelectionOutcome } from '../ports/selectionOutcome';
import type {
  DataFolderPlugins, DecidePluginOrder, InstanceAdapter, PluginEntry, PluginOrderChange,
} from '../instanceAdapter/instanceAdapter';

/** What a plugins command reaches the instance through. */
export interface PluginsAccess {
  readonly adapter: InstanceAdapter;
}

/** `wrote` is false when the gesture was already true of plugin order: a command that changes
 *  nothing writes nothing, so it never fires the watch. */
export type PluginsCommandResult =
  | { applied: true; wrote: boolean }
  | { applied: false; refusal: string };

async function changePluginOrder(
  access: PluginsAccess, profile: string, decide: DecidePluginOrder,
): Promise<PluginsCommandResult> {
  try {
    // A change already true of the order is not written: for `syncPlugins` that is the
    // difference between a loop that settles and one that does not.
    const { wrote } = await access.adapter.changePluginOrder(profile, decide);
    return { applied: true, wrote };
  } catch (err) {
    return refuse(err);
  }
}

/** A gesture over a selection, in one write: each item landed or refused by name, or the whole
 *  selection refused once when plugin order cannot be read or written. */
export type PluginsSelectionResult =
  | { applied: true; outcome: SelectionOutcome<string> }
  | { applied: false; refusal: string };

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
  access: PluginsAccess, profile: string, entries: readonly PluginParticipation[],
): Promise<PluginsSelectionResult> {
  let landed: string[] = [];
  let refused: ItemRefusal<string>[] = [];
  const outcome = await changePluginOrder(access, profile, (order) => {
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
  access: PluginsAccess, profile: string, pluginNames: readonly string[], enabled: boolean,
): Promise<PluginsSelectionResult> {
  return setPluginsParticipation(access, profile, pluginNames.map((name) => ({ name, enabled })));
}

/** Where a drag landed in the Plugins tree. */
export type { Drop as PluginsDrop } from './dropIndex';

/** What the plugin-order rules ask mEdit: the masters query. */
export type PluginMasters = Pick<MEditClient, 'getPlugins'>;

// plugins.txt has no origin, so a name two origins hold names no one plugin: it is not judged.
// Nothing is judged while mEdit cannot answer (plugins.md, Drag and drop, story 3).
async function orderFactsFrom(masters: PluginMasters): Promise<PluginOrderFactsOf> {
  const held = await masters.getPlugins().catch(() => [] as PluginMetadata[]);
  const byName = new Map<string, PluginOrderFacts | undefined>();
  for (const { name, masters: own, isBlueprint } of held) {
    const key = pluginKey(name);
    byName.set(key, byName.has(key) ? undefined : { masters: own, blueprint: isBlueprint });
  }
  return (name) => byName.get(pluginKey(name));
}

/** `modbench.plugin.move`: the block lands where the drop says, unless that breaks the plugin-order
 *  rules of the order it lands on. */
export async function reorderPlugins(
  access: PluginsAccess, masters: PluginMasters, profile: string, pluginNames: string[], drop: Drop,
): Promise<PluginsCommandResult> {
  const factsOf = await orderFactsFrom(masters);
  let refusal: string | undefined;
  // Settled against the order the change lands on, so a tree a generation behind plugins.txt
  // cannot land the block at a stale index.
  const result = await changePluginOrder(access, profile, (order) => {
    const names = order.map((p) => p.name);
    refusal = moveOrderRefusal(names, pluginNames, drop, factsOf);
    return refusal === undefined ? [{ kind: 'move', plugins: pluginNames, toIndex: dropIndexIn(names, pluginNames, drop) }] : [];
  });
  return refusal === undefined ? result : { applied: false, refusal };
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

/** `modbench.plugin.sync`: plugins.txt is the inventory the Plugins tree reads, so when disk
 *  disagrees the file is updated. Every input is the value's, handed in; this walks nothing. */
export async function syncPlugins(
  access: PluginsAccess, { profile, pluginOrder, provided, inData, loadedWithNoLine }: PluginSyncInputs,
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
  const result = await changePluginOrder(access, profile, (order) => {
    if (changedSinceRead(order, pluginOrder)) return [];
    delta = pluginLinesDelta(order.map((e) => e.name), addable, inDataNames);
    return [
      ...delta.dropped.map((plugin): PluginOrderChange => ({ kind: 'drop', plugin })),
      ...delta.added.map((plugin): PluginOrderChange => ({ kind: 'add', plugin })),
    ];
  });
  return result.applied ? { ...result, ...delta } : result;
}

/** Plugin sync's inputs, which the instance value carries. */
export interface PluginSyncInputs {
  readonly profile: string;
  readonly pluginOrder: readonly PluginEntry[];
  readonly provided: ReadonlyMap<string, string>;
  readonly inData: DataFolderPlugins;
  readonly loadedWithNoLine: readonly string[] | undefined;
}

/** Plugin sync on one run's inputs. */
export type PluginSyncRun = (inputs: PluginSyncInputs) => Promise<PluginSyncResult>;

/** `syncPlugins` bound to one instance. */
export function pluginSyncOver(access: PluginsAccess): PluginSyncRun {
  return (inputs) => syncPlugins(access, inputs);
}

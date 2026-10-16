// Every change to a profile's plugin order (ADR-0014; ADR-0015).

import { pluginKey } from '../loadOrderFileCodec/pluginsText';
import { dropIndexIn, type Drop } from './dropIndex';
import type { CommandResult, SelectionResult } from '../coreLib/commandResult';
export type { SelectionResult };
import { refuse } from '../ports/refuse';
import type { MEditClient, PluginAddress } from '../client';
import type { TailOf } from '../coreLib/boundCommand';
import { pluginRenameCommands, type PluginRenameClient } from './renamePlugin';
import { moveOrderRefusal, type PluginOrderFactsOf } from './pluginOrder';
import type { ItemRefusal } from '../ports/selectionOutcome';
import type { DecidePluginOrder, InstanceAdapter, PluginOrderChange, PluginsProvided } from '../instanceAdapter/instanceAdapter';
import { isReadFailed } from '../wire/readFailed';

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

// `modbench.plugin.enable` / `modbench.plugin.disable` and the check box, over the whole
//  selection in one write (commands.md, "A selection is one gesture") — every entry lands or is
//  refused by name, whatever state each one asks for.
async function setPluginsParticipation(
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

// `setPluginsParticipation`, one state for the whole selection — the menu and the key's own
//  shape, which never mixes directions in one gesture.
function setPluginsEnabled(
  adapter: InstanceAdapter, profile: string, pluginNames: readonly string[], enabled: boolean,
): Promise<SelectionResult<string>> {
  return setPluginsParticipation(adapter, profile, pluginNames.map((name) => ({ name, enabled })));
}

/** Where a drag landed in the Plugins tree. */
export type { Drop as PluginsDrop } from './dropIndex';

type PluginMasters = Pick<MEditClient, 'getPlugins'>;

// The game loads one copy of a name: the one in the load order (ADR-0012). Several copies with
// none in it name no one copy, so none is judged; nor is anything while mEdit cannot answer.
async function orderFactsFrom(masters: PluginMasters): Promise<PluginOrderFactsOf> {
  const answer = await masters.getPlugins().catch(() => undefined);
  const held = answer === undefined || isReadFailed(answer) ? [] : answer;
  return (name) => {
    const copies = held.filter((plugin) => pluginKey(plugin.name) === pluginKey(name));
    const loaded = copies.length === 1 ? copies : copies.filter((copy) => copy.inLoadOrder);
    const [copy] = loaded;
    return loaded.length === 1 && copy !== undefined ? { masters: copy.masters, blueprint: copy.isBlueprint } : undefined;
  };
}

async function reorderPlugins(
  { adapter, client: masters }: { adapter: InstanceAdapter; client: PluginMasters }, profile: string, plugins: readonly PluginAddress[], drop: Drop,
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

type PluginSyncResult =
  | { applied: true; wrote: boolean; added: string[]; dropped: string[] }
  | { applied: false; refusal: string }
  | { applied: false; toldAsInstanceState: true };

// The tree gives a plugin the game loads with no line a row of its own (plugins.md, The tree,
// story 2), so it earns no line, wherever it is provided from.
function pluginLinesDelta(listed: readonly string[], { plugins, loadedWithNoLine }: Extract<PluginsProvided, { kind: 'listed' }>): PluginLinesDelta {
  const listedKeys = new Set(listed.map(pluginKey));
  const noLine = new Set(loadedWithNoLine.map(pluginKey));
  const added = [...plugins]
    .filter(([key]) => !listedKeys.has(key) && !noLine.has(key))
    .map(([, real]) => real)
    .sort((a, b) => pluginKey(a).localeCompare(pluginKey(b)));
  const dropped = listed.filter((name) => !plugins.has(pluginKey(name)));
  return { added, dropped };
}

async function syncPlugins(adapter: InstanceAdapter): Promise<PluginSyncResult> {
  const profile = await adapter.activeProfile();
  const decided = { gameFolderNotFound: false };
  let delta: PluginLinesDelta = { added: [], dropped: [] };
  try {
    const { wrote } = await adapter.changePluginOrderOverProvided(profile, (order, provided) => {
      // Without the Data folder's listing, a line for a Data plugin would be dropped. A game folder
      // not found is told once, as the instance's state (common.md, States, story 5).
      if (provided.kind === 'unresolved') {
        decided.gameFolderNotFound = true;
        return [];
      }
      if (provided.kind === 'unreadable') throw new Error(`the game's Data folder cannot be listed: ${provided.reason}`);
      delta = pluginLinesDelta(order.map((e) => e.name), provided);
      return [
        ...delta.dropped.map((plugin): PluginOrderChange => ({ kind: 'drop', plugin })),
        ...delta.added.map((plugin): PluginOrderChange => ({ kind: 'add', plugin })),
      ];
    });
    return decided.gameFolderNotFound ? { applied: false, toldAsInstanceState: true } : { applied: true, wrote, ...delta };
  } catch (err) {
    return refuse(err);
  }
}

/** Plugin sync over the active profile. */
export type PluginSyncRun = () => Promise<PluginSyncResult>;

/** `syncPlugins` bound to one instance. */
export function pluginSyncOver(adapter: InstanceAdapter): PluginSyncRun {
  return () => syncPlugins(adapter);
}

/** The Plugins commands, bound to one instance and one mEdit client: each takes the gesture's arguments only. */
export function pluginsCommands({ adapter, client }: { adapter: InstanceAdapter; client: PluginMasters & PluginRenameClient }) {
  return {
    setPluginsParticipation: (...args: TailOf<typeof setPluginsParticipation>) => setPluginsParticipation(adapter, ...args),
    setPluginsEnabled: (...args: TailOf<typeof setPluginsEnabled>) => setPluginsEnabled(adapter, ...args),
    reorderPlugins: (...args: TailOf<typeof reorderPlugins>) => reorderPlugins({ adapter, client }, ...args),
    ...pluginRenameCommands({ adapter, client }),
  };
}

export type PluginsCommands = ReturnType<typeof pluginsCommands>;

// Every change to a profile's plugin order (ADR-0014; ADR-0015).

import { pluginKey } from '../loadOrderFileCodec/pluginsText';
import { dropIndexIn, type Drop } from './dropIndex';
import type { CommandResult, SelectionResult } from '../coreLib/commandResult';
export type { SelectionResult };
import { refuse } from '../coreLib/refuse';
import { present } from '../ports/present';
import type { MEditClient, PluginAddress } from '../client';
import type { TailOf } from '../coreLib/boundCommand';
import { pluginRenameCommands, type PluginRenameClient } from './renamePlugin';
import { moveOrderRefusal, type PluginOrderFactsOf } from './pluginOrder';
import type { ItemRefusal } from '../ports/selectionOutcome';
import type {
  DecidePluginOrder, DecidePluginOrderOverProvided, InstanceAdapter, PluginOrderChange, PluginsProvided,
} from '../instanceAdapter/instanceAdapter';
import { isReadFailed } from '../wire/readFailed';

interface Decision<T> {
  readonly changes: readonly PluginOrderChange[];
  readonly decided: T;
}

// The adapter takes the changes alone, so what `decide` concluded comes back here. A change
// already true of the order is not written: for `syncPlugins` that is the difference between a
// loop that settles and one that does not.
async function changeDeciding<A extends unknown[], T extends object>(
  write: (decide: (...args: A) => readonly PluginOrderChange[]) => Promise<{ readonly wrote: boolean }>,
  decide: (...args: A) => Decision<T>,
): Promise<CommandResult<{ wrote: boolean; decided: T }>> {
  const decisions: T[] = [];
  try {
    const { wrote } = await write((...args) => {
      const { changes, decided } = decide(...args);
      decisions.push(decided);
      return changes;
    });
    return { applied: true, wrote, decided: present(decisions.at(-1), 'the decision the change landed on') };
  } catch (err) {
    return refuse(err);
  }
}

const overOrder = (adapter: InstanceAdapter, profile: string) => (decide: DecidePluginOrder) => adapter.changePluginOrder(profile, decide);

async function changePluginOrder(adapter: InstanceAdapter, profile: string, decide: DecidePluginOrder): Promise<CommandResult> {
  const outcome = await changeDeciding(overOrder(adapter, profile), (order) => ({ changes: decide(order), decided: {} }));
  return outcome.applied ? { applied: true, wrote: outcome.wrote } : outcome;
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
  const outcome = await changeDeciding(overOrder(adapter, profile), (order) => {
    const known = new Set(order.map((entry) => pluginKey(entry.name)));
    const found = entries.filter((entry) => known.has(pluginKey(entry.name)));
    const refused: ItemRefusal<string>[] = entries.filter((entry) => !known.has(pluginKey(entry.name)))
      .map((entry) => ({ item: entry.name, reason: `Plugin not found in plugins.txt: ${entry.name}` }));
    return {
      changes: found.map(({ name, enabled }): PluginOrderChange => ({ kind: 'enable', plugin: name, enabled })),
      decided: { landed: found.map((entry) => entry.name), refused },
    };
  });
  return outcome.applied ? { applied: true, outcome: outcome.decided } : outcome;
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
  const overProvided = (decide: DecidePluginOrderOverProvided) => adapter.changePluginOrderOverProvided(profile, decide);
  const outcome = await changeDeciding(overProvided, (order, provided): Decision<PluginLinesDelta | { gameFolderNotFound: true }> => {
    // Without the Data folder's listing, a line for a Data plugin would be dropped. A game folder
    // not found is told once, as the instance's state (common.md, States, story 5).
    if (provided.kind === 'unresolved') return { changes: [], decided: { gameFolderNotFound: true } };
    if (provided.kind === 'unreadable') throw new Error(`the game's Data folder cannot be listed: ${provided.reason}`);
    const delta = pluginLinesDelta(order.map((e) => e.name), provided);
    return {
      changes: [
        ...delta.dropped.map((plugin): PluginOrderChange => ({ kind: 'drop', plugin })),
        ...delta.added.map((plugin): PluginOrderChange => ({ kind: 'add', plugin })),
      ],
      decided: delta,
    };
  });
  if (!outcome.applied) return outcome;
  return 'gameFolderNotFound' in outcome.decided ? { applied: false, toldAsInstanceState: true } : { applied: true, wrote: outcome.wrote, ...outcome.decided };
}

/** Plugin sync over the active profile. */
export type PluginSyncRun = () => Promise<PluginSyncResult>;

/** `syncPlugins` bound to one instance. */
export function pluginSyncOver(adapter: InstanceAdapter): PluginSyncRun {
  return () => syncPlugins(adapter);
}

/** Plugin commands, bound to one instance and one mEdit client: each takes the gesture's arguments only. */
export function pluginCommands({ adapter, client }: { adapter: InstanceAdapter; client: PluginMasters & PluginRenameClient }) {
  return {
    setPluginsParticipation: (...args: TailOf<typeof setPluginsParticipation>) => setPluginsParticipation(adapter, ...args),
    setPluginsEnabled: (...args: TailOf<typeof setPluginsEnabled>) => setPluginsEnabled(adapter, ...args),
    reorderPlugins: (...args: TailOf<typeof reorderPlugins>) => reorderPlugins({ adapter, client }, ...args),
    ...pluginRenameCommands({ adapter, client }),
  };
}

export type PluginCommands = ReturnType<typeof pluginCommands>;

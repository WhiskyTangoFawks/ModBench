// Every change to a profile's plugin order (ADR-0014; ADR-0015).

import { pluginKey } from '../loadOrderFileCodec/pluginsText';
import { dropIndexIn, type Drop } from './dropIndex';
import type { CommandResult, SelectionResult } from '../coreLib/commandResult';
export type { SelectionResult };
import { refuse } from '../coreLib/refuse';
import { present } from '../ports/present';
import type { MEditClient, ModStatus, PluginAddress, ReadModStatus } from '../client';
import type { TailOf } from '../coreLib/boundCommand';
import { pluginRenameCommands, type PluginRenameClient } from './renamePlugin';
import type { PluginFactsOf } from '../sortingRules/judge';
import { moveOrderRefusal } from './pluginOrder';
import { decompileAndRepair, type DecompileAndRepairClient } from './decompileAndRepair';
import type { ItemRefusal } from '../ports/selectionOutcome';
import type {
  DecidePluginOrder, DecidePluginOrderOverProvided, InstanceAdapter, PluginEntry, PluginOrderChange, PluginsProvided,
} from '../instanceAdapter/instanceAdapter';
import { pluginsNotRestored } from './pluginsNotRestored';
import { failureReason, isReadFailed } from '../wire/readFailed';

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

const overOrder = (adapter: InstanceAdapter) => async (decide: DecidePluginOrder) =>
  adapter.changePluginOrder(await adapter.activeProfile(), decide);

const overProvided = (adapter: InstanceAdapter) => async (decide: DecidePluginOrderOverProvided) =>
  adapter.changePluginOrderOverProvided(await adapter.activeProfile(), decide);

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
  adapter: InstanceAdapter, entries: readonly PluginParticipation[],
): Promise<SelectionResult<string>> {
  const outcome = await changeDeciding(overOrder(adapter), (order) => {
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
  adapter: InstanceAdapter, pluginNames: readonly string[], enabled: boolean,
): Promise<SelectionResult<string>> {
  return setPluginsParticipation(adapter, pluginNames.map((name) => ({ name, enabled })));
}

/** Where a drag landed in the Plugins tree. */
export type { Drop as PluginsDrop } from './dropIndex';

type PluginMasters = Pick<MEditClient, 'getPlugins'>;

// The game loads one copy of a name: the one in the load order (ADR-0012). Several copies with
// none in it name no one copy, so none is judged; nor is anything while mEdit cannot answer.
async function orderFactsFrom(masters: PluginMasters): Promise<PluginFactsOf> {
  const answer = await masters.getPlugins().catch(() => undefined);
  const held = answer === undefined || isReadFailed(answer) ? [] : answer;
  return (name) => {
    const copies = held.filter((plugin) => pluginKey(plugin.name) === pluginKey(name));
    const loaded = copies.length === 1 ? copies : copies.filter((copy) => copy.inLoadOrder);
    const [copy] = loaded;
    return loaded.length === 1 && copy !== undefined ? { origin: copy.origin, masters: copy.masters, blueprint: copy.isBlueprint } : undefined;
  };
}

async function reorderPlugins(
  { adapter, client: masters }: { adapter: InstanceAdapter; client: PluginMasters }, plugins: readonly PluginAddress[], drop: Drop,
): Promise<CommandResult> {
  const pluginNames = plugins.map((plugin) => plugin.name);
  if ('name' in drop && pluginNames.some((name) => pluginKey(name) === pluginKey(drop.name))) {
    return { applied: false, refusal: `The target is "${drop.name}", which is moving.` };
  }
  const factsOf = await orderFactsFrom(masters);
  // Settled against the order the change lands on, so a tree a generation behind plugins.txt
  // cannot land the block at a stale index.
  const outcome = await changeDeciding(overProvided(adapter), (order, provided) => {
    const names = order.map((p) => p.name);
    const noLine = new Set(provided.kind === 'listed' ? provided.loadedWithNoLine.map(pluginKey) : []);
    // A line for a plugin the game loads with no line does not place it.
    const refusal = moveOrderRefusal(names.filter((name) => !noLine.has(pluginKey(name))), pluginNames, drop, factsOf);
    if (refusal !== undefined) throw new Error(refusal);
    return { changes: [{ kind: 'move', plugins: pluginNames, toIndex: dropIndexIn(names, pluginNames, drop) }], decided: {} };
  });
  return outcome.applied ? { applied: true, wrote: outcome.wrote } : outcome;
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

/** Each mod's status as mEdit last answered it, and each time a new answer lands. */
export interface LastModStatuses {
  of(mod: string): ModStatus | undefined;
  onDidChange(listener: () => void): { dispose(): void };
}

interface ManifestsRead {
  goneFrom(mod: string): readonly string[];
  unread(mod: string): string | undefined;
}

const NOTHING_NAMED: ManifestsRead = { goneFrom: () => [], unread: () => undefined };

const lastAnswered = (last: Pick<LastModStatuses, 'of'>): ManifestsRead => ({ goneFrom: (mod) => last.of(mod)?.gone ?? [], unread: () => undefined });

// A plugin the game loads with no line has a row of its own, so earns no line (plugins.md, The tree, story 2). A
// plugin a manifest names is on no disk until restore (story 10).
function pluginLinesDelta(
  listed: readonly string[], provided: Extract<PluginsProvided, { kind: 'listed' }>, manifests: ManifestsRead,
): PluginLinesDelta {
  const notRestored = [...pluginsNotRestored(provided.enabledMods, (mod) => manifests.goneFrom(mod)).values()];
  const plugins = new Map([...notRestored.map(({ name }) => [pluginKey(name), name] as const), ...provided.plugins]);
  const listedKeys = new Set(listed.map(pluginKey));
  const noLine = new Set(provided.loadedWithNoLine.map(pluginKey));
  const added = [...plugins]
    .filter(([key]) => !listedKeys.has(key) && !noLine.has(key))
    .map(([, real]) => real)
    .sort((a, b) => pluginKey(a).localeCompare(pluginKey(b)));
  const dropped = listed.filter((name) => !plugins.has(pluginKey(name)));
  const unread = provided.enabledMods.flatMap((mod) => manifests.unread(mod) ?? []);
  if (dropped.length > 0 && unread.length > 0) throw new Error([...new Set(unread)].join('; '));
  return { added, dropped };
}

// The mod order is read apart from the plugins provided, so a mod it did not list was not asked.
async function askedManifests(adapter: InstanceAdapter, readStatus: ReadModStatus): Promise<ManifestsRead> {
  const asked = new Set((await adapter.modOrder()).mods.flatMap((entry) => (entry.kind === 'mod' ? [entry.name] : [])));
  const answer = await readStatus([...asked]);
  if (isReadFailed(answer)) {
    const why = `the mods' manifests could not be read: ${failureReason(answer)}`;
    return { goneFrom: () => [], unread: () => why };
  }
  const statusOf = new Map(answer.map((status) => [status.mod, status]));
  return {
    goneFrom: (mod) => statusOf.get(mod)?.gone ?? [],
    unread: (mod) => {
      if (!asked.has(mod)) return `the manifest of "${mod}" was not read`;
      const why = statusOf.get(mod)?.unreadable?.why;
      return why === undefined ? undefined : `the status of "${mod}" could not be read: ${why}`;
    },
  };
}

type SyncDecision = PluginLinesDelta | { gameFolderNotFound: true };

function decideSync(order: readonly PluginEntry[], provided: PluginsProvided, manifests: ManifestsRead): Decision<SyncDecision> {
  // Without the Data folder's listing, a line for a Data plugin would be dropped. A game folder
  // not found is told once, as the instance's state (common.md, States, story 5).
  if (provided.kind === 'unresolved') return { changes: [], decided: { gameFolderNotFound: true } };
  if (provided.kind === 'unreadable') throw new Error(`the game's Data folder cannot be listed: ${provided.reason}`);
  const delta = pluginLinesDelta(order.map((e) => e.name), provided, manifests);
  return {
    changes: [
      ...delta.dropped.map((plugin): PluginOrderChange => ({ kind: 'drop', plugin })),
      ...delta.added.map((plugin): PluginOrderChange => ({ kind: 'add', plugin })),
    ],
    decided: delta,
  };
}

const dropsFromDisk = (order: readonly PluginEntry[], provided: PluginsProvided): boolean =>
  provided.kind === 'listed' && order.some(({ name }) => !provided.plugins.has(pluginKey(name)));

const synced = (wrote: boolean, decided: SyncDecision): PluginSyncResult =>
  ('gameFolderNotFound' in decided ? { applied: false, toldAsInstanceState: true } : { applied: true, wrote, ...decided });

// An add waits safely on mEdit's last answer, since its next answer runs the sync again. A drop loses the line's place,
// so it waits on the manifests as mEdit reads them now.
async function syncPlugins(adapter: InstanceAdapter, readStatus: ReadModStatus, last: Pick<LastModStatuses, 'of'>): Promise<PluginSyncResult> {
  const repository = await adapter.repositoryOnDisk();
  const lastRead = repository ? lastAnswered(last) : NOTHING_NAMED;
  const first = await changeDeciding(overProvided(adapter), (order, provided): Decision<SyncDecision | { askNow: true }> =>
    (repository && dropsFromDisk(order, provided) ? { changes: [], decided: { askNow: true } } : decideSync(order, provided, lastRead)));
  if (!first.applied) return first;
  if (!('askNow' in first.decided)) return synced(first.wrote, first.decided);
  const now = await askedManifests(adapter, readStatus);
  const second = await changeDeciding(overProvided(adapter), (order, provided) => decideSync(order, provided, now));
  return second.applied ? synced(second.wrote, second.decided) : second;
}

/** Plugin sync over the active profile. */
export type PluginSyncRun = () => Promise<PluginSyncResult>;

/** `syncPlugins` bound to one instance, to mEdit's read of each mod's status, and to its last answer. */
export function pluginSyncOver(adapter: InstanceAdapter, readStatus: ReadModStatus, last: Pick<LastModStatuses, 'of'>): PluginSyncRun {
  return () => syncPlugins(adapter, readStatus, last);
}

/** Plugin commands, bound to one instance and one mEdit client: each takes the gesture's arguments only. */
export function pluginCommands({ adapter, client }: { adapter: InstanceAdapter; client: PluginMasters & PluginRenameClient & DecompileAndRepairClient }) {
  return {
    setPluginsParticipation: (...args: TailOf<typeof setPluginsParticipation>) => setPluginsParticipation(adapter, ...args),
    setPluginsEnabled: (...args: TailOf<typeof setPluginsEnabled>) => setPluginsEnabled(adapter, ...args),
    reorderPlugins: (...args: TailOf<typeof reorderPlugins>) => reorderPlugins({ adapter, client }, ...args),
    decompileAndRepair: (...args: TailOf<typeof decompileAndRepair>) => decompileAndRepair({ adapter, client }, ...args),
    ...pluginRenameCommands({ adapter, client }),
  };
}

export type PluginCommands = ReturnType<typeof pluginCommands>;

// Every change to a profile's plugin order. Commands return applied-or-refusal, never throw
// (ADR-0014), and never read the Instance — its watcher is how a write comes back (ADR-0015).

import { foldPath } from '../instanceLoader/fileConflictIndex';
import type { DataFolderPlugins } from '../instanceLoader/loadOrderSnapshot';
import { dropIndexIn, type Drop } from './dropIndex';
import { refuse } from '../ports/refuse';
import { applyOrThrow } from '../ports/applyOrThrow';
import type { ItemRefusal, SelectionOutcome } from '../ports/selectionOutcome';
import type { DecidePluginOrder, InstanceAdapter, PluginOrderChange } from '../instanceAdapter/instanceAdapter';

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

export function reorderPlugins(
  access: PluginsAccess, profile: string, pluginNames: string[], drop: Drop,
): Promise<PluginsCommandResult> {
  // Settled against the order the change lands on, so a tree a generation behind plugins.txt
  // cannot land the block at a stale index.
  return changePluginOrder(access, profile, (order) =>
    [{ kind: 'move', plugins: pluginNames, toIndex: dropIndexIn(order.map((p) => p.name), pluginNames, drop) }]);
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
  const listedFolded = new Set(listed.map(foldPath));
  const added = [...provided]
    .filter(([folded]) => !listedFolded.has(folded))
    .map(([, real]) => real)
    .sort((a, b) => foldPath(a).localeCompare(foldPath(b)));
  const dropped = listed.filter((name) => !provided.has(foldPath(name)) && !inData.has(foldPath(name)));
  return { added, dropped };
}

/** Answers the plugins this install loads with no plugins.txt line, or `undefined` when the
 *  backend that knows them cannot be reached. Only the backend can answer it: deriving the set
 *  here would mean parsing plugin headers (ADR-0016). */
export type ImplicitMasterSource = () => Promise<readonly string[] | undefined>;

/** `modbench.plugin.sync`: plugins.txt is the inventory the Plugins tree reads, so when disk
 *  disagrees the file is updated. `provided` is the value's winners and `inData` its Data-folder
 *  presence, both handed in — this walks nothing. */
export async function syncPlugins(
  access: PluginsAccess, profile: string, provided: ReadonlyMap<string, string>,
  inData: DataFolderPlugins, implicitMasters: ImplicitMasterSource,
): Promise<PluginSyncResult> {
  // Without the Data folder's listing, a line for a Data plugin would be dropped. A game folder
  // not found is told once, as the instance's state (common.md, States, story 5).
  if (inData.kind === 'unresolved') return { applied: false, toldAsInstanceState: true };
  if (inData.kind === 'unreadable') {
    return { applied: false, refusal: `the game's Data folder cannot be listed: ${inData.reason}` };
  }
  // Without the implicit masters, a mod's plugin named like a vanilla master would earn a line
  // (ADR-0013, invariant 3).
  let addable: ReadonlyMap<string, string>;
  try {
    const implicit = await implicitMasters();
    if (implicit === undefined) {
      return { applied: false, refusal: 'mEdit cannot say which plugins the game loads with no line' };
    }
    // An implicit master is left out: the tree gives it a row of its own, never from a line, so
    // a mod's plugin of that name must not earn a line.
    const implicitFolded = new Set(implicit.map(foldPath));
    addable = new Map([...provided].filter(([folded]) => !implicitFolded.has(folded)));
  } catch (err) {
    return refuse(err);
  }
  const inDataNames = inData.names;

  let delta: PluginLinesDelta = { added: [], dropped: [] };
  const result = await changePluginOrder(access, profile, (order) => {
    // The delta is decided from the order the change lands on, so two overlapping runs can
    // neither add a line twice nor drop one the other just wrote.
    delta = pluginLinesDelta(order.map((e) => e.name), addable, inDataNames);
    return [
      ...delta.dropped.map((plugin): PluginOrderChange => ({ kind: 'drop', plugin })),
      ...delta.added.map((plugin): PluginOrderChange => ({ kind: 'add', plugin })),
    ];
  });
  return result.applied ? { ...result, ...delta } : result;
}

/** Plugin sync's inputs, as the composition root projects them off a landed value. */
export interface PluginSyncInputs {
  profile: string;
  provided: ReadonlyMap<string, string>;
  inData: DataFolderPlugins;
  dataFolder: string | undefined;
  gameRelease: string | undefined;
}

/** The plugins the game loads with no line, for a Data folder and a game; undefined when mEdit
 *  cannot say. */
export type ImplicitMastersIn = (
  dataFolder: string | undefined, gameRelease: string | undefined,
) => Promise<readonly string[] | undefined>;

/** Plugin sync on one run's inputs. */
export type PluginSyncRun = (inputs: PluginSyncInputs) => Promise<PluginSyncResult>;

/** `syncPlugins` bound to one instance, its implicit masters asked for each run's Data folder and
 *  game. */
export function pluginSyncOver(access: PluginsAccess, implicitMastersIn: ImplicitMastersIn): PluginSyncRun {
  return ({ profile, provided, inData, dataFolder, gameRelease }) =>
    syncPlugins(access, profile, provided, inData, () => implicitMastersIn(dataFolder, gameRelease));
}

/** `reorderPlugins` bound to one instance and the profile it names now; a refusal rejects, the
 *  shape ADR-0019's notify-and-log path is written against. */
export function reorderOver(
  access: PluginsAccess, profile: () => string,
): (pluginNames: string[], drop: Drop) => Promise<void> {
  return async (pluginNames, drop) => applyOrThrow(await reorderPlugins(access, profile(), pluginNames, drop));
}

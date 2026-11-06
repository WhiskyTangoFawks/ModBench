// The switch profile gesture (ADR-0015), refresh and the rename of a profile, bound to one instance.

import type { MEditClient } from '../client';
import { refuse } from '../coreLib/refuse';
import type { CommandResult } from '../coreLib/commandResult';
import type { TailOf } from '../coreLib/boundCommand';
import type { InstanceAdapter } from '../instanceAdapter/instanceAdapter';
import type { RefreshResult } from './loadOrder';
import { change, committedBy, type RenameEditing } from '../coreLib/change';
import type { ChangeResult } from '../ports/changeResult';

// Refuses a name the instance does not hold: selecting a profile whose directory is not there
//  points the whole instance at files that do not exist, which no later read can tell from a
//  corrupt ini.
async function switchProfile(adapter: InstanceAdapter, profile: string): Promise<CommandResult> {
  try {
    if (!(await adapter.profiles()).includes(profile)) {
      return { applied: false, refusal: `No such profile: ${profile}` };
    }
    const { wrote } = await adapter.selectProfile(profile);
    return { applied: true, wrote };
  } catch (err) {
    return refuse(err);
  }
}

// commands.md, `modbench.symbol.followRename`: its folder, the mod manager's selected profile and the publisher's
// configuration.
function renameProfile(adapter: InstanceAdapter, { held, apply }: RenameEditing, from: string, to: string): Promise<ChangeResult> {
  const owners = { definition: committedBy(() => adapter.renameProfile(from, to)), references: [] };
  return change(owners, (owner) => owner.plan({ kind: 'profile', name: from }, to, held), apply);
}

async function refresh(
  adapter: InstanceAdapter, client: Pick<MEditClient, 'rebuildIndex'>, instanceRoot: string,
): Promise<RefreshResult> {
  try {
    const outcome = await client.rebuildIndex(instanceRoot, await adapter.gameRelease());
    if (outcome.rebuilt) return { applied: true };
    return outcome.heldElsewhere
      ? { applied: false, heldElsewhere: true }
      : { applied: false, heldElsewhere: false, refusal: outcome.detail };
  } catch (err) {
    return { ...refuse(err), heldElsewhere: false };
  }
}

/** The instance-wide commands, bound to one instance: each takes the gesture's arguments only. */
export function instanceCommands(
  { adapter, client, instanceRoot }: { adapter: InstanceAdapter; client: Pick<MEditClient, 'rebuildIndex'>; instanceRoot: string },
) {
  return {
    switchProfile: (...args: TailOf<typeof switchProfile>) => switchProfile(adapter, ...args),
    refresh: () => refresh(adapter, client, instanceRoot),
    renameProfile: (...args: TailOf<typeof renameProfile>) => renameProfile(adapter, ...args),
  };
}

export type InstanceCommands = ReturnType<typeof instanceCommands>;

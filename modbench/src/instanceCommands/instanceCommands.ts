// The switch profile gesture (ADR-0015) and refresh, bound to one instance.

import type { MEditClient } from '../client';
import { refuse } from '../ports/refuse';
import type { CommandResult } from '../coreLib/commandResult';
import type { InstanceAdapter } from '../instanceAdapter/instanceAdapter';
import type { TailOf } from '../coreLib/boundCommand';
import { releaseOf, type InstanceGame, type RefreshResult } from './loadOrder';

/** Refuses a name the value's `profiles` does not hold: selecting a profile whose directory is
 *  not there points the whole instance at files that do not exist, which no later read can tell
 *  from a corrupt ini. */
async function switchProfile(
  adapter: InstanceAdapter, profile: string, profiles: readonly string[],
): Promise<CommandResult> {
  if (!profiles.includes(profile)) {
    return { applied: false, refusal: `No such profile: ${profile}` };
  }
  try {
    const { wrote } = await adapter.selectProfile(profile);
    return { applied: true, wrote };
  } catch (err) {
    return refuse(err);
  }
}

async function refresh(
  client: Pick<MEditClient, 'rebuildIndex'>, instanceRoot: string, game: InstanceGame,
): Promise<RefreshResult> {
  const outcome = await client.rebuildIndex(instanceRoot, releaseOf(game));
  if (outcome.rebuilt) return { applied: true };
  return outcome.heldElsewhere
    ? { applied: false, heldElsewhere: true }
    : { applied: false, heldElsewhere: false, refusal: outcome.detail };
}

/** The instance-wide commands, bound to one instance: each takes the gesture's arguments only. */
export function instanceCommands(
  { adapter, client, instanceRoot }: { adapter: InstanceAdapter; client: Pick<MEditClient, 'rebuildIndex'>; instanceRoot: string },
) {
  return {
    switchProfile: (...args: TailOf<typeof switchProfile>) => switchProfile(adapter, ...args),
    refresh: (game: InstanceGame) => refresh(client, instanceRoot, game),
  };
}

export type InstanceCommands = ReturnType<typeof instanceCommands>;
